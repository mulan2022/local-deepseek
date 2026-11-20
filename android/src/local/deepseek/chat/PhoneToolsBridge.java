package local.deepseek.chat;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.media.projection.MediaProjectionConfig;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;

public final class PhoneToolsBridge {
    private static final int CAPTURE = 6;
    private static final int NOTIFICATIONS = 5;
    static final String DEFAULT_FOLDER = "default";
    private static final String LEGACY_PREFS = "phone_tools";
    private static final String CONTEXT_PREFS = "phone_tools_context";
    private static final String REGISTRY_PREFS = "phone_tools_folders";
    private static final String FOLDER_PREFIX = "phone_tools_folder_";
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BiConsumer<String, String> intentResult;
    private volatile Activity activity;
    private volatile boolean resumed;
    private volatile String folderId;
    private boolean capturePending;

    PhoneToolsBridge(Context context, BiConsumer<String, String> intentResult) {
        this.context = context;
        this.intentResult = intentResult;
        folderId = currentFolder(context);
    }

    void attach(Activity next) {
        activity = next;
        resumed = false;
        capturePending = false;
    }

    void setResumed(Activity owner, boolean value) {
        if (activity == owner) resumed = value;
    }

    boolean isResumed() { return resumed; }

    static String folder(String folderId) {
        return folderId == null || folderId.isEmpty() ? DEFAULT_FOLDER : folderId;
    }

    static String currentFolder(Context context) {
        return folder(context.getSharedPreferences(CONTEXT_PREFS, Context.MODE_PRIVATE)
            .getString("folderId", DEFAULT_FOLDER));
    }

    private static byte[] folderHash(String folderId) {
        try {
            return MessageDigest.getInstance("SHA-256")
                .digest(folder(folderId).getBytes(StandardCharsets.UTF_8));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String folderPrefsName(String folderId) {
        StringBuilder encoded = new StringBuilder(FOLDER_PREFIX);
        for (byte value : folderHash(folderId)) encoded.append(String.format("%02x", value & 0xff));
        return encoded.toString();
    }

    static int folderJobId(String folderId) {
        byte[] hash = folderHash(folderId);
        int value = (hash[0] & 0x7f) << 24 | (hash[1] & 0xff) << 16 | (hash[2] & 0xff) << 8 | hash[3] & 0xff;
        return 100_000 + value % 1_000_000_000;
    }

    static Set<String> folderIds(Context context) {
        Set<String> ids = new HashSet<>(context.getSharedPreferences(REGISTRY_PREFS, Context.MODE_PRIVATE)
            .getStringSet("ids", java.util.Collections.emptySet()));
        ids.add(currentFolder(context));
        return ids;
    }

    static SharedPreferences prefs(Context context) {
        return prefs(context, currentFolder(context));
    }

    static synchronized SharedPreferences prefs(Context context, String folderId) {
        String selected = folder(folderId);
        Set<String> ids = new HashSet<>(context.getSharedPreferences(REGISTRY_PREFS, Context.MODE_PRIVATE)
            .getStringSet("ids", java.util.Collections.emptySet()));
        if (ids.add(selected)) {
            context.getSharedPreferences(REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
                .putStringSet("ids", ids).apply();
        }
        SharedPreferences settings = context.getSharedPreferences(folderPrefsName(selected), Context.MODE_PRIVATE);
        SharedPreferences state = context.getSharedPreferences(CONTEXT_PREFS, Context.MODE_PRIVATE);
        if (DEFAULT_FOLDER.equals(selected) && !state.getBoolean("legacyMigrated", false)) {
            SharedPreferences legacy = context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE);
            Map<String, ?> oldValues = legacy.getAll();
            Map<String, ?> newValues = settings.getAll();
            SharedPreferences.Editor copy = settings.edit();
            for (Map.Entry<String, ?> entry : oldValues.entrySet()) {
                if (!newValues.containsKey(entry.getKey())) put(copy, entry.getKey(), entry.getValue());
            }
            copy.apply();
            state.edit().putBoolean("legacyMigrated", true).apply();
        }
        return settings;
    }

    @SuppressWarnings("unchecked")
    private static void put(SharedPreferences.Editor editor, String key, Object value) {
        if (value instanceof String) editor.putString(key, (String) value);
        else if (value instanceof Boolean) editor.putBoolean(key, (Boolean) value);
        else if (value instanceof Integer) editor.putInt(key, (Integer) value);
        else if (value instanceof Long) editor.putLong(key, (Long) value);
        else if (value instanceof Float) editor.putFloat(key, (Float) value);
        else if (value instanceof Set) editor.putStringSet(key, new HashSet<>((Set<String>) value));
    }

    static int ocrChangePercent(Context context) {
        return ocrChangePercent(context, currentFolder(context));
    }

    static int ocrChangePercent(Context context, String folderId) {
        SharedPreferences settings = prefs(context, folderId);
        // Upgrade the previous default; explicitly saved values in the new UI remain respected.
        if (!settings.getBoolean("ocrTextGateV2", false)) {
            int old = settings.getInt("ocrChangePercent", 30);
            settings.edit().putInt("ocrChangePercent", old == 30 ? 60 : old)
                .putBoolean("ocrTextGateV2", true).apply();
        }
        return settings.getInt("ocrChangePercent", 60);
    }

    private SharedPreferences settings() { return prefs(context, folderId); }
    private boolean enabled(String feature) { return settings().getBoolean(feature, false); }

    @JavascriptInterface
    public void setFolder(String next) {
        String selected = folder(next);
        if (selected.equals(folderId)) return;
        ScreenObserver.stop();
        folderId = selected;
        context.getSharedPreferences(CONTEXT_PREFS, Context.MODE_PRIVATE).edit()
            .putString("folderId", selected).apply();
        settings();
        ScreenCaptureService.refreshObserver(selected);
        main.post(() -> ChatWebView.observationChanged(context,
            enabled("ocr") && enabled("capture") && ScreenCaptureService.active()));
    }

    @JavascriptInterface
    public void copyFolder(String source, String target) {
        String from = folder(source);
        String to = folder(target);
        if (from.equals(to)) return;
        SharedPreferences sourceSettings = prefs(context, from);
        SharedPreferences targetSettings = prefs(context, to);
        SharedPreferences.Editor copy = targetSettings.edit().clear();
        for (Map.Entry<String, ?> entry : sourceSettings.getAll().entrySet()) {
            put(copy, entry.getKey(), entry.getValue());
        }
        copy.apply();
        if (targetSettings.getBoolean("heartbeat", false)) HeartbeatJob.enqueue(context, to);
    }

    @JavascriptInterface
    public void deleteFolder(String target) {
        String selected = folder(target);
        if (selected.equals(folderId)) ScreenObserver.stop();
        HeartbeatJob.deleteFolder(context, selected);
        context.getSharedPreferences(folderPrefsName(selected), Context.MODE_PRIVATE).edit().clear().apply();
        synchronized (PhoneToolsBridge.class) {
            Set<String> ids = folderIds(context);
            ids.remove(selected);
            context.getSharedPreferences(REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
                .putStringSet("ids", ids).apply();
        }
    }

    @JavascriptInterface
    public String state() {
        SharedPreferences settings = settings();
        try {
            return new JSONObject().put("folderId", folderId).put("capture", enabled("capture"))
                .put("intents", enabled("intents")).put("heartbeat", enabled("heartbeat"))
                .put("captureActive", ScreenCaptureService.active())
                .put("captureStatus", ScreenCaptureService.status(context, folderId))
                .put("captureMessage", ScreenCaptureService.message(context, folderId))
                .put("ocr", enabled("ocr")).put("ocrSessionId", settings.getString("ocrSessionId", ""))
                .put("ocrIntervalSeconds", settings.getInt("ocrIntervalSeconds", 1))
                .put("ocrBatchChars", settings.getInt("ocrBatchChars", 500))
                .put("ocrWaitSeconds", settings.getInt("ocrWaitSeconds", 15))
                .put("ocrChangePercent", ocrChangePercent(context, folderId))
                .put("ocrStatus", ScreenObserver.status()).put("ocrFrames", ScreenObserver.count())
                .put("ocrBytes", ScreenObserver.bytes())
                .put("mode", settings.getString("heartbeatMode", "off"))
                .put("value", settings.getString("heartbeatValue", ""))
                .put("task", settings.getString("heartbeatTask", ""))
                .put("sessionId", settings.getString("heartbeatSession", ""))
                .put("nextAt", settings.getLong("heartbeatNext", 0))
                .put("lastAt", settings.getLong("heartbeatLast", 0))
                .put("lastResult", settings.getString("heartbeatResult", ""))
                .put("lastFailed", settings.getBoolean("heartbeatFailed", false)).toString();
        } catch (Exception failed) {
            return "{}";
        }
    }

    @JavascriptInterface
    public void setEnabled(String feature, boolean value) {
        switch (feature) {
            case "capture":
            case "intents":
            case "ocr":
                settings().edit().putBoolean(feature, value).apply();
                if ("capture".equals(feature) && !value) stopCapture();
                if ("ocr".equals(feature)) {
                    if (!value) ScreenObserver.stop();
                    ScreenCaptureService.refreshObserver(folderId);
                    main.post(() -> ChatWebView.observationChanged(context,
                        enabled("ocr") && enabled("capture") && ScreenCaptureService.active()));
                }
                break;
            case "heartbeat":
                if (value) settings().edit().putBoolean(feature, true).apply();
                else HeartbeatJob.cancelSchedule(context, folderId, true);
                break;
            default:
                break;
        }
    }

    @JavascriptInterface
    public void startCapture() {
        Activity activity = this.activity;
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (!enabled("capture") || capturePending || ScreenCaptureService.active() || activity.isFinishing()) return;
            try {
                capturePending = true;
                MediaProjectionManager manager = activity.getSystemService(MediaProjectionManager.class);
                Intent consent = Build.VERSION.SDK_INT >= 34
                    ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                    : manager.createScreenCaptureIntent();
                activity.startActivityForResult(consent, CAPTURE);
            } catch (RuntimeException failed) {
                capturePending = false;
                captureFailure("error", "无法打开屏幕共享授权，请回到应用重试。");
            }
        });
    }

    void onActivityResult(int code, int result, Intent data) {
        Activity activity = this.activity;
        if (activity == null) return;
        if (code != CAPTURE || !capturePending) return;
        capturePending = false;
        if (!enabled("capture")) return;
        if (ScreenCaptureService.active()) return;
        if (result != Activity.RESULT_OK || data == null) {
            captureFailure("denied", "屏幕共享授权未完成，请重新授权。");
            return;
        }
        try {
            activity.startForegroundService(new Intent(activity, ScreenCaptureService.class)
                .setAction(ScreenCaptureService.START).putExtra(ScreenCaptureService.FOLDER, folderId)
                .putExtra(ScreenCaptureService.RESULT, result).putExtra(ScreenCaptureService.DATA, data));
        } catch (RuntimeException failed) {
            captureFailure("error", "屏幕共享服务启动失败，请回到应用重新授权。");
        }
    }

    private void captureFailure(String status, String message) {
        settings().edit().putString("captureStoppedStatus", status)
            .putString("captureStoppedMessage", message).apply();
    }

    @JavascriptInterface
    public void stopCapture() {
        context.stopService(new Intent(context, ScreenCaptureService.class));
    }

    @JavascriptInterface
    public String captureFrame() { return enabled("capture") ? ScreenCaptureService.frame() : ""; }

    @JavascriptInterface
    public String captureStatus() {
        return enabled("capture") ? ScreenCaptureService.status(context, folderId) : "inactive";
    }

    @JavascriptInterface
    public String configureOcr(String sessionId, int intervalSeconds, int batchChars, int waitSeconds, int changePercent) {
        if (sessionId == null || sessionId.isEmpty() || sessionId.length() > 200
                || intervalSeconds < 1 || intervalSeconds > 60 || batchChars < 50 || batchChars > 10000
                || waitSeconds < 1 || waitSeconds > 120 || changePercent < 5 || changePercent > 100)
            return "OCR 参数无效";
        settings().edit().putString("ocrSessionId", sessionId).putInt("ocrIntervalSeconds", intervalSeconds)
            .putInt("ocrBatchChars", batchChars).putInt("ocrWaitSeconds", waitSeconds)
            .putInt("ocrChangePercent", changePercent).putBoolean("ocrTextGateV2", true).apply();
        ScreenCaptureService.refreshObserver(folderId);
        return "";
    }

    @JavascriptInterface public String pendingObservation() { return ScreenObserver.pending(context, folderId); }
    @JavascriptInterface public String observationBatch(String sessionId) { return ScreenObserver.active(sessionId); }
    @JavascriptInterface public String observationImage(String batchId, String imageId, String sessionId) {
        return ScreenObserver.image(batchId, imageId, sessionId);
    }
    @JavascriptInterface public void completeObservation(String batchId, String status) {
        if ("done".equals(status) || "error".equals(status) || "busy".equals(status)) ScreenObserver.complete(batchId, status);
    }

    @JavascriptInterface
    public String configureHeartbeat(String mode, String value, String task, String sessionId) {
        return HeartbeatJob.configure(context, folderId, mode, value, task, sessionId);
    }

    @JavascriptInterface
    public void requestNotifications() {
        Activity activity = this.activity;
        if (activity == null) return;
        if (Build.VERSION.SDK_INT < 33) return;
        activity.runOnUiThread(() -> {
            if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATIONS);
            }
        });
    }

    private static String argument(JSONObject data, String key, int max) {
        String value = data.optString(key, "").trim();
        if (value.length() > max) throw new IllegalArgumentException(key);
        return value;
    }

    private static Intent buildIntent(String action, JSONObject args) {
        switch (action) {
            case "open_url": {
                Uri url = Uri.parse(argument(args, "url", 2048));
                if (!("http".equals(url.getScheme()) || "https".equals(url.getScheme()))
                        || url.getHost() == null || url.getUserInfo() != null) throw new IllegalArgumentException();
                return new Intent(Intent.ACTION_VIEW, url);
            }
            case "map": {
                String place = argument(args, "place", 300);
                if (place.isEmpty()) throw new IllegalArgumentException();
                return new Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(place)));
            }
            case "dial":
            case "sms": {
                String number = argument(args, "number", 64);
                if (!number.matches("[+0-9 ()-]+") || !number.matches(".*[0-9].*")) throw new IllegalArgumentException();
                if ("dial".equals(action)) return new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null));
                return new Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", number, null))
                    .putExtra("sms_body", argument(args, "text", 2000));
            }
            case "email": {
                String to = argument(args, "to", 320);
                if (!to.contains("@") || to.contains("\n") || to.contains("\r")) throw new IllegalArgumentException();
                return new Intent(Intent.ACTION_SENDTO, Uri.fromParts("mailto", to, null))
                    .putExtra(Intent.EXTRA_SUBJECT, argument(args, "subject", 240))
                    .putExtra(Intent.EXTRA_TEXT, argument(args, "body", 3000));
            }
            case "alarm": {
                String value = argument(args, "time", 5);
                if (!value.matches("[0-2][0-9]:[0-5][0-9]")) throw new IllegalArgumentException();
                LocalTime at = LocalTime.parse(value);
                return new Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, at.getHour())
                    .putExtra(AlarmClock.EXTRA_MINUTES, at.getMinute())
                    .putExtra(AlarmClock.EXTRA_MESSAGE, argument(args, "label", 120))
                    .putExtra(AlarmClock.EXTRA_SKIP_UI, false);
            }
            case "calendar": {
                ZoneId zone = ZoneId.systemDefault();
                long start = LocalDateTime.parse(argument(args, "start", 25)).atZone(zone).toInstant().toEpochMilli();
                long end = LocalDateTime.parse(argument(args, "end", 25)).atZone(zone).toInstant().toEpochMilli();
                String title = argument(args, "title", 240);
                if (title.isEmpty() || end <= start) throw new IllegalArgumentException();
                return new Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
                    .putExtra(CalendarContract.Events.TITLE, title)
                    .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
                    .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end);
            }
            case "share": {
                String text = argument(args, "text", 3000);
                if (text.isEmpty()) throw new IllegalArgumentException();
                return Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, text), "");
            }
            default:
                throw new IllegalArgumentException();
        }
    }

    @JavascriptInterface
    public String runIntent(String action, String json, String requestId) {
        Activity activity = this.activity;
        if (activity == null) return "应用当前未显示";
        if (!enabled("intents")) return "手机快捷操作未开启";
        if (requestId == null || !requestId.matches("[a-zA-Z0-9-]{1,100}")) return "操作请求无效";
        final Intent intent;
        try {
            intent = buildIntent(action, new JSONObject(json));
        } catch (Exception invalid) {
            return "手机操作参数不完整或格式无效";
        }
        // Return to WebView before the UI thread launches the system activity.
        main.post(() -> intentResult.accept(requestId, launchIntent(activity, intent)));
        return "";
    }

    private String launchIntent(Activity owner, Intent intent) {
        if (!enabled("intents")) return "手机快捷操作未开启";
        if (activity != owner || !resumed || owner.isFinishing() || owner.isDestroyed()) {
            return "请让聊天应用保持在前台，然后重试快捷操作";
        }
        try {
            owner.startActivity(intent);
            return "";
        } catch (ActivityNotFoundException unavailable) {
            return "手机上没有可处理此操作的应用";
        } catch (SecurityException denied) {
            return "安卓拒绝打开此系统界面";
        } catch (RuntimeException failed) {
            return "无法打开此系统界面";
        }
    }
}
