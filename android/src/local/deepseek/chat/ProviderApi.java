package local.deepseek.chat;

import android.webkit.JavascriptInterface;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Direct on-device transport for the model and catalog endpoints used by the WebView. */
public final class ProviderApi {
    static final String PREFIX = "/_provider_api/";
    private static final String[] HEADERS = {
        "authorization", "x-api-key", "anthropic-version", "content-type", "accept"
    };
    private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();

    private static final class Call {
        final URI uri;
        final String method;
        final JSONObject headers;
        final byte[] body;
        final long created = android.os.SystemClock.elapsedRealtime();
        volatile HttpsURLConnection connection;

        Call(URI uri, String method, JSONObject headers, String body) {
            this.uri = uri;
            this.method = method;
            this.headers = headers;
            this.body = body.getBytes(StandardCharsets.UTF_8);
        }
    }

    private static boolean supported(URI url, String method) {
        if (!"https".equals(url.getScheme()) || url.getHost() == null
                || url.getUserInfo() != null || url.getFragment() != null) return false;
        String host = url.getHost();
        String path = url.getRawPath();
        boolean get = "GET".equals(method);
        if (!get && !"POST".equals(method)) return false;
        switch (host) {
            case "api.anthropic.com":
                return path.equals(get ? "/v1/models" : "/v1/messages");
            case "api.openai.com":
                return path.equals(get ? "/v1/models" : "/v1/responses")
                    || (!get && path.equals("/v1/chat/completions"));
            case "generativelanguage.googleapis.com":
                return path.equals(get ? "/v1beta/openai/models" : "/v1beta/openai/chat/completions");
            case "api.moonshot.cn":
            case "api.moonshot.ai":
                return path.equals(get ? "/v1/models" : "/v1/chat/completions");
            case "open.bigmodel.cn":
            case "api.z.ai":
                return path.equals(get ? "/api/paas/v4/models" : "/api/paas/v4/chat/completions");
            default:
                boolean qwen = host.equals("dashscope.aliyuncs.com")
                    || host.matches("dashscope-(intl|us)\\.aliyuncs\\.com")
                    || host.matches("[a-z0-9-]+\\.(cn-beijing|cn-hongkong|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1)\\.maas\\.aliyuncs\\.com");
                if (qwen && path.equals(get ? "/api/v1/models" : "/compatible-mode/v1/chat/completions")) return true;
                // Custom relays may use OpenAI Responses/Chat Completions or Anthropic Messages.
                if (get) return path.endsWith("/models");
                return path.endsWith("/chat/completions") || path.endsWith("/responses") || path.endsWith("/messages");
        }
    }

    @JavascriptInterface
    public String prepare(String url, String method, String headers, String body) {
        try {
            URI uri = URI.create(url);
            if (!supported(uri, method)) return "";
            long cutoff = android.os.SystemClock.elapsedRealtime() - 60_000;
            calls.entrySet().removeIf(entry -> entry.getValue().connection == null
                && entry.getValue().created < cutoff);
            String id = UUID.randomUUID().toString();
            calls.put(id, new Call(uri, method, new JSONObject(headers), body));
            return id;
        } catch (Exception rejected) {
            return "";
        }
    }

    @JavascriptInterface
    public void cancel(String id) {
        Call call = calls.remove(id);
        if (call != null && call.connection != null) call.connection.disconnect();
    }

    void close() {
        for (String id : calls.keySet()) cancel(id);
    }

    WebResourceResponse serve(String id) {
        Call call = calls.get(id);
        if (call == null) return error(404, "Not Found");
        try {
            HttpsURLConnection connection = (HttpsURLConnection) call.uri.toURL().openConnection();
            synchronized (call) {
                if (call.connection != null || calls.get(id) != call) return error(404, "Not Found");
                call.connection = connection;
            }
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(180_000);
            connection.setRequestMethod(call.method);
            for (String header : HEADERS) {
                if (call.headers.has(header)) connection.setRequestProperty(header, call.headers.getString(header));
            }
            if ("POST".equals(call.method)) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(call.body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(call.body); }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 600 || (status >= 300 && status < 400)) {
                cancel(id);
                return error(502, "Invalid Provider Response");
            }
            String type = connection.getContentType();
            String mime = type != null && type.startsWith("text/event-stream")
                ? "text/event-stream" : "application/json";
            InputStream body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            InputStream stream = new FilterInputStream(body != null ? body : new ByteArrayInputStream(new byte[0])) {
                @Override public void close() throws IOException {
                    try { super.close(); } finally { cancel(id); }
                }
            };
            return new WebResourceResponse(mime, "UTF-8", status, status < 300 ? "OK" : "Provider Error",
                Collections.singletonMap("Cache-Control", "no-store"), stream);
        } catch (Exception error) {
            cancel(id);
            return error(502, "Provider Connection Failed");
        }
    }

    private static WebResourceResponse error(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason,
            Collections.singletonMap("Cache-Control", "no-store"),
            new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }
}
