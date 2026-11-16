package local.deepseek.chat;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.view.WindowInsets;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLConnection;
import java.util.Collections;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://localhost";
    private static final String CONTENT_SECURITY_POLICY =
        "script-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; "
        + "connect-src 'self' https://api.deepseek.com";
    private static final String AUDIO = PermissionRequest.RESOURCE_AUDIO_CAPTURE;
    private static final int PICK_FILE = 1;
    private static final int REQUEST_MICROPHONE = 2;
    private static final int SAVE_FILE = 3;

    private final LocalFiles localFiles = new LocalFiles();
    private WebView webView;
    private ValueCallback<Uri[]> fileChooser;
    private PermissionRequest microphone;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new LocalContent());
        webView.setWebChromeClient(new AndroidDialogs());
        webView.addJavascriptInterface(localFiles, "AndroidLocalFiles");
        if (Build.VERSION.SDK_INT >= 30) {
            webView.setOnApplyWindowInsetsListener((view, windowInsets) -> {
                Insets insets = windowInsets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                    | WindowInsets.Type.ime());
                view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
                return windowInsets;
            });
        }
        setContentView(webView);
        webView.loadUrl(ORIGIN + "/index.html");
    }

    private static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && "localhost".equals(uri.getAuthority());
    }

    private final class LocalContent extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isLocal(uri)) return false;
            if (request.isForMainFrame() && ("https".equals(uri.getScheme())
                    || "http".equals(uri.getScheme()))) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                }
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isLocal(uri)) return null;
            String path = uri.getPath();
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
                InputStream file = getAssets().open("web" + path);
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

    private final class AndroidDialogs extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                FileChooserParams params) {
            if (fileChooser != null) fileChooser.onReceiveValue(null);
            fileChooser = callback;
            try {
                startActivityForResult(params.createIntent(), PICK_FILE);
            } catch (ActivityNotFoundException error) {
                fileChooser = null;
                callback.onReceiveValue(null);
            }
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean requestsAudio = false;
            for (String resource : request.getResources()) {
                requestsAudio |= AUDIO.equals(resource);
            }
            if (!isLocal(request.getOrigin()) || !requestsAudio) {
                request.deny();
            } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] { AUDIO });
            } else if (microphone == null) {
                microphone = request;
                requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
            } else {
                request.deny();
            }
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (microphone == request) microphone = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == REQUEST_MICROPHONE && microphone != null) {
            PermissionRequest request = microphone;
            microphone = null;
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] { AUDIO });
            } else {
                request.deny();
            }
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == PICK_FILE && fileChooser != null) {
            ValueCallback<Uri[]> callback = fileChooser;
            fileChooser = null;
            callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        }
        if (code == SAVE_FILE) {
            localFiles.writeTo(result == RESULT_OK && data != null ? data.getData() : null);
        }
    }

    public final class LocalFiles {
        private File pending;
        private boolean saving;

        @JavascriptInterface
        public synchronized boolean begin() {
            if (saving || pending != null) return false;
            try {
                pending = File.createTempFile("export-", ".tmp", getCacheDir());
                return true;
            } catch (IOException error) {
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean append(String chunk) {
            if (pending == null || saving) return false;
            try (OutputStream out = new FileOutputStream(pending, true)) {
                out.write(Base64.decode(chunk, Base64.DEFAULT));
                return true;
            } catch (IOException | IllegalArgumentException error) {
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean chooseDestination(String name, String type) {
            if (pending == null || saving) return false;
            saving = true;
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(type)
                    .putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(intent, SAVE_FILE);
                } catch (ActivityNotFoundException error) {
                    reset();
                    Toast.makeText(MainActivity.this, "无法打开保存窗口", Toast.LENGTH_SHORT).show();
                }
            });
            return true;
        }

        @JavascriptInterface
        public synchronized void cancel() {
            if (!saving) reset();
        }

        private synchronized void reset() {
            if (pending != null) pending.delete();
            pending = null;
            saving = false;
        }

        private synchronized void writeTo(Uri destination) {
            if (destination == null || pending == null) {
                reset();
                return;
            }
            File source = pending;
            new Thread(() -> {
                boolean success = false;
                try (InputStream in = new java.io.FileInputStream(source);
                        OutputStream out = getContentResolver().openOutputStream(destination, "w")) {
                    if (out == null) throw new IOException("Cannot open destination");
                    byte[] buffer = new byte[64 * 1024];
                    int length;
                    while ((length = in.read(buffer)) != -1) out.write(buffer, 0, length);
                    out.flush();
                    success = true;
                } catch (IOException | SecurityException ignored) {
                    // A storage provider can revoke access while writing.
                } finally {
                    reset();
                }
                String message = success ? "文件已保存" : "文件保存失败";
                runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
            }, "local-file-export").start();
        }
    }
}
