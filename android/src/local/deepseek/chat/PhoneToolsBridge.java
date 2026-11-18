package local.deepseek.chat;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.function.BiConsumer;

public final class PhoneToolsBridge {
    private static final int CAPTURE = 4;
    private static final int NOTIFICATIONS = 5;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BiConsumer<String, String> intentResult;
    private volatile Activity activity;
    private boolean resumed;
    private boolean capturePending;

    PhoneToolsBridge(Context context, BiConsumer<String, String> intentResult) {
        this.context = context;
        this.intentResult = intentResult;
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

    static SharedPreferences prefs(android.content.Context context) {
        return context.getSharedPreferences("phone_tools", android.content.Context.MODE_PRIVATE);
    }

    private boolean enabled(String feature) { return prefs(context).getBoolean(feature, false); }

    @JavascriptInterface
    public String state() {
        SharedPreferences settings = prefs(context);
        try {
            return new JSONObject().put("capture", enabled("capture"))
                .put("intents", enabled("intents")).put("heartbeat", enabled("heartbeat"))
                .put("captureActive", ScreenCaptureService.active())
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
                prefs(context).edit().putBoolean(feature, value).apply();
                if ("capture".equals(feature) && !value) stopCapture();
                break;
            case "heartbeat":
                if (value) prefs(context).edit().putBoolean(feature, true).apply();
                else HeartbeatJob.cancelSchedule(context, true);
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
                activity.startActivityForResult(manager.createScreenCaptureIntent(), CAPTURE);
            } catch (RuntimeException failed) {
                capturePending = false;
            }
        });
    }

    void onActivityResult(int code, int result, Intent data) {
        Activity activity = this.activity;
        if (activity == null) return;
        if (code != CAPTURE) return;
        capturePending = false;
        if (result != Activity.RESULT_OK || data == null || !enabled("capture")) return;
        try {
            activity.startForegroundService(new Intent(activity, ScreenCaptureService.class)
                .setAction(ScreenCaptureService.START)
                .putExtra(ScreenCaptureService.RESULT, result).putExtra(ScreenCaptureService.DATA, data));
        } catch (RuntimeException failed) {
            // A failed launch is reflected as an inactive capture session.
        }
    }

    @JavascriptInterface
    public void stopCapture() {
        context.stopService(new Intent(context, ScreenCaptureService.class));
    }

    @JavascriptInterface
    public String captureFrame() { return enabled("capture") ? ScreenCaptureService.frame() : ""; }

    @JavascriptInterface
    public String captureStatus() { return enabled("capture") ? ScreenCaptureService.status() : "inactive"; }

    @JavascriptInterface
    public String configureHeartbeat(String mode, String value, String task, String sessionId) {
        return HeartbeatJob.configure(context, mode, value, task, sessionId);
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
