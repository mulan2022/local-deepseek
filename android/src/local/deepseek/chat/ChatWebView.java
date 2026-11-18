package local.deepseek.chat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.net.Uri;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLConnection;
import java.util.Collections;
import java.util.Map;

public final class ChatWebView {
    private static final String ORIGIN = "https://localhost";
    private static final String CONTENT_SECURITY_POLICY =
        "script-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; "
        + "connect-src 'self' https://api.deepseek.com";
    private static volatile ChatWebView current;

    final WebView view;
    final PhoneToolsBridge phoneTools;
    private final Context context;
    private final MutableContextWrapper viewContext;
    private final ProviderApi providerApi = new ProviderApi();
    private volatile MainActivity activity;
    private volatile boolean floating;
    private boolean runningHeartbeat;

    private ChatWebView(Context source) {
        context = source.getApplicationContext();
        viewContext = new MutableContextWrapper(context);
        view = new WebView(viewContext);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        phoneTools = new PhoneToolsBridge(context, this::notifyIntentResult);
        view.setWebViewClient(new LocalContent());
        view.addJavascriptInterface(providerApi, "AndroidProviderApi");
        view.addJavascriptInterface(phoneTools, "AndroidPhoneTools");
        view.addJavascriptInterface(new HeartbeatJob.Bridge(), "AndroidHeartbeat");
        view.addJavascriptInterface(new ExportFiles(), "AndroidLocalFiles");
        view.addJavascriptInterface(new FloatingChat(), "AndroidFloatingChat");
        view.loadUrl(ORIGIN + "/index.html");
    }

    static ChatWebView get(Context context) {
        if (current == null) current = new ChatWebView(context);
        return current;
    }

    void attach(MainActivity next) {
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        activity = next;
        viewContext.setBaseContext(next);
        phoneTools.attach(next);
    }

    void detach(Activity owner) {
        if (activity != owner) return;
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        activity = null;
        viewContext.setBaseContext(context);
        phoneTools.attach(null);
        view.setOnApplyWindowInsetsListener(null);
        view.setWebChromeClient(null);
        releaseIfIdle();
    }

    void startHeartbeat() {
        runningHeartbeat = true;
        dispatchHeartbeat();
    }

    void finishHeartbeat() {
        runningHeartbeat = false;
        if (activity != null) dispatchHeartbeat();
        releaseIfIdle();
    }

    static void refreshHeartbeat() {
        if (current != null && current.runningHeartbeat) current.dispatchHeartbeat();
    }

    static boolean isHeadless() {
        ChatWebView page = current;
        return page != null && page.activity == null;
    }

    static boolean isForeground() {
        ChatWebView page = current;
        return page != null && (page.floating || page.phoneTools.isResumed());
    }

    void notifyFloatingChat(String status) {
        if ("open".equals(status) || "closed".equals(status)) floating = "open".equals(status);
        view.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-floating-chat', {detail:"
            + JSONObject.quote(status) + "}))", null);
    }

    public final class FloatingChat {
        @JavascriptInterface public boolean active() { return floating; }

        @JavascriptInterface public void open() {
            MainActivity owner = activity;
            if (owner != null) owner.runOnUiThread(owner::openFloatingChat);
        }

        @JavascriptInterface public void focusInput(boolean focused) {
            MainActivity owner = activity;
            if (owner != null && floating) owner.runOnUiThread(() -> owner.focusFloatingInput(focused));
        }
    }

    private void dispatchHeartbeat() {
        view.evaluateJavascript("window.dispatchEvent(new Event('android-heartbeat'))", null);
    }

    private void notifyIntentResult(String id, String error) {
        if (current != this) return;
        view.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-intent-result', {detail:{id:"
            + JSONObject.quote(id) + ",error:" + JSONObject.quote(error) + "}}))", null);
    }

    private void releaseIfIdle() {
        if (activity != null || runningHeartbeat) return;
        current = null;
        providerApi.close();
        view.destroy();
    }

    static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && "localhost".equals(uri.getAuthority());
    }

    public final class ExportFiles {
        @JavascriptInterface public boolean begin() {
            MainActivity owner = activity;
            return owner != null && owner.localFiles.begin();
        }
        @JavascriptInterface public boolean append(String chunk) {
            MainActivity owner = activity;
            return owner != null && owner.localFiles.append(chunk);
        }
        @JavascriptInterface public boolean chooseDestination(String name, String type) {
            MainActivity owner = activity;
            return owner != null && owner.localFiles.chooseDestination(name, type);
        }
        @JavascriptInterface public void cancel() {
            MainActivity owner = activity;
            if (owner != null) owner.localFiles.cancel();
        }
    }

    private final class LocalContent extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isLocal(uri)) return false;
            if (request.isForMainFrame() && ("https".equals(uri.getScheme())
                    || "http".equals(uri.getScheme()))) {
                try {
                    if (activity != null) activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    Toast.makeText(context, "无法打开链接", Toast.LENGTH_SHORT).show();
                }
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isLocal(uri)) return null;
            String path = uri.getPath();
            if (!request.isForMainFrame() && "GET".equals(request.getMethod()) && path != null
                    && path.startsWith(ProviderApi.PREFIX)) {
                return providerApi.serve(path.substring(ProviderApi.PREFIX.length()));
            }
            if ("/".equals(path)) path = "/index.html";
            if (!"/index.html".equals(path) && !"/LICENSE".equals(path)
                    && (path == null || !path.startsWith("/static/")
                        || path.contains("..") || path.contains("\\"))) {
                return missingAsset();
            }
            String mimeType = URLConnection.guessContentTypeFromName(path);
            if (path.endsWith(".js")) mimeType = "text/javascript";
            if (path.endsWith(".css")) mimeType = "text/css";
            if (path.endsWith(".woff2")) mimeType = "font/woff2";
            if (path.endsWith(".woff")) mimeType = "font/woff";
            if (path.endsWith(".ttf")) mimeType = "font/ttf";
            if (mimeType == null) mimeType = path.equals("/LICENSE")
                ? "text/plain" : "application/octet-stream";
            try {
                InputStream file = context.getAssets().open("web" + path);
                Map<String, String> headers = path.equals("/index.html")
                    ? Collections.singletonMap("Content-Security-Policy", CONTENT_SECURITY_POLICY)
                    : Collections.emptyMap();
                String charset = mimeType.startsWith("text/") ? "UTF-8" : null;
                return new WebResourceResponse(mimeType, charset, 200, "OK", headers, file);
            } catch (IOException error) {
                return missingAsset();
            }
        }

        private WebResourceResponse missingAsset() {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
    }

}
