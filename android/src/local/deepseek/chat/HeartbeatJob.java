package local.deepseek.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.UUID;

public final class HeartbeatJob extends JobService {
    private static final int JOB_ID = 1842;
    private static final int NOTIFICATION_ID = 1842;
    private static final String CHANNEL = "heartbeat";
    private static final int TASK_LIMIT = 2000;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile Run current;
    private static Runnable localWakeup;
    private static String localWakeupFolder;

    private static final class Run {
        final Context context;
        final HeartbeatJob job;
        final JobParameters params;
        final String folderId;
        final String id;
        final String sessionId;
        final String task;
        final String revision;
        final String mode;
        final String value;
        final long dueAt;
        final int count;
        final long at;
        final ChatWebView page;
        final Runnable timeout;

        Run(Context context, HeartbeatJob job, JobParameters params, SharedPreferences prefs,
                String folderId, String revision, long dueAt) {
            this.context = context;
            this.job = job;
            this.params = params;
            this.folderId = folderId;
            this.revision = revision;
            this.dueAt = dueAt;
            sessionId = prefs.getString("heartbeatSession", "");
            task = prefs.getString("heartbeatTask", "");
            mode = prefs.getString("heartbeatMode", "");
            value = prefs.getString("heartbeatValue", "");
            count = prefs.getInt("heartbeatCount", 0) + 1;
            at = System.currentTimeMillis();
            id = "heartbeat:" + revision + ":" + dueAt;
            page = ChatWebView.get(context);
            timeout = () -> complete(this, "error", "Heartbeat 执行超时");
        }
    }

    private static int jobId(String folderId) {
        String selected = PhoneToolsBridge.folder(folderId);
        if (PhoneToolsBridge.DEFAULT_FOLDER.equals(selected)) return JOB_ID;
        return PhoneToolsBridge.folderJobId(selected);
    }

    static boolean isEnabled(Context context) {
        return isEnabled(context, PhoneToolsBridge.currentFolder(context));
    }

    static boolean isEnabled(Context context, String folderId) {
        return PhoneToolsBridge.prefs(context, folderId).getBoolean("heartbeat", false);
    }

    static String configure(Context context, String mode, String value, String task, String sessionId) {
        return configure(context, PhoneToolsBridge.currentFolder(context), mode, value, task, sessionId);
    }

    static synchronized String configure(Context context, String folderId,
            String mode, String value, String task, String sessionId) {
        String selected = PhoneToolsBridge.folder(folderId);
        if (!isEnabled(context, selected)) return "Heartbeat 尚未启用";
        if ("off".equals(mode)) {
            cancelSchedule(context, selected, false);
            return "";
        }
        ZonedDateTime now = ZonedDateTime.now();
        long at = nextTime(mode, value, now);
        if (task == null || task.length() > TASK_LIMIT || sessionId == null || sessionId.isEmpty() || sessionId.length() > 200 || at == 0) {
            return "请选择会话，并使用 1–604800 秒的整数（如 5s）或有效的 HH:mm 时间";
        }
        SharedPreferences prefs = PhoneToolsBridge.prefs(context, selected);
        String revision = UUID.randomUUID().toString();
        boolean running = current != null && current.folderId.equals(selected);
        if (!running && !schedule(context, selected, revision, at)) {
            return "安卓没有接受这条后台计划";
        }
        prefs.edit().putString("heartbeatMode", mode).putString("heartbeatValue", value)
            .putString("heartbeatTask", task.trim()).putString("heartbeatSession", sessionId)
            .putString("heartbeatRevision", revision).putLong("heartbeatNext", at).putInt("heartbeatCount", 0)
            .apply();
        if (!running) armLocalWakeup(context, selected, revision, at, at);
        return "";
    }

    static void cancelSchedule(Context context, boolean disable) {
        cancelSchedule(context, PhoneToolsBridge.currentFolder(context), disable);
    }

    static synchronized void cancelSchedule(Context context, String folderId, boolean disable) {
        String selected = PhoneToolsBridge.folder(folderId);
        SharedPreferences.Editor editor = PhoneToolsBridge.prefs(context, selected).edit()
            .remove("heartbeatMode").remove("heartbeatValue").remove("heartbeatTask")
            .remove("heartbeatRevision").remove("heartbeatNext").remove("heartbeatSession").remove("heartbeatCount");
        if (disable) editor.putBoolean("heartbeat", false);
        editor.apply();
        clearLocalWakeup(selected);
        if (disable || current == null || !current.folderId.equals(selected)) {
            context.getSystemService(JobScheduler.class).cancel(jobId(selected));
            MAIN.post(ChatWebView::refreshHeartbeat);
        }
    }

    static synchronized void deleteFolder(Context context, String folderId) {
        String selected = PhoneToolsBridge.folder(folderId);
        cancelSchedule(context, selected, true);
        Run run = current;
        if (run != null && run.folderId.equals(selected)) {
            current = null;
            MAIN.removeCallbacks(run.timeout);
            run.page.finishHeartbeat();
        }
    }

    private static long durationMillis(String value) {
        if (value == null || !value.matches("[0-9]+s?")) return 0;
        try {
            boolean seconds = value.endsWith("s");
            int duration = Integer.parseInt(seconds ? value.substring(0, value.length() - 1) : value);
            long millis = duration * (seconds ? 1_000L : 60_000L);
            return millis >= 1_000 && millis <= 604_800_000 ? millis : 0;
        } catch (NumberFormatException invalid) {
            return 0;
        }
    }

    static long nextTime(String mode, String value, ZonedDateTime now) {
        try {
            if ("interval".equals(mode) || "after".equals(mode)) {
                long delay = durationMillis(value);
                if (delay > 0) {
                    return now.toInstant().toEpochMilli() + delay;
                }
            }
            if (("daily".equals(mode) || "at".equals(mode)) && value.matches("[0-2][0-9]:[0-5][0-9]")) {
                LocalTime clock = LocalTime.parse(value);
                ZonedDateTime at = now.toLocalDate().atTime(clock).atZone(now.getZone());
                if (!at.isAfter(now)) at = now.toLocalDate().plusDays(1).atTime(clock).atZone(now.getZone());
                return at.toInstant().toEpochMilli();
            }
        } catch (RuntimeException invalid) {}
        return 0;
    }

    static boolean enqueue(Context context) {
        return enqueue(context, PhoneToolsBridge.currentFolder(context));
    }

    static synchronized boolean enqueue(Context context, String folderId) {
        String selected = PhoneToolsBridge.folder(folderId);
        SharedPreferences prefs = PhoneToolsBridge.prefs(context, selected);
        if (!isEnabled(context, selected) || (current != null && current.folderId.equals(selected))) return false;
        long at = prefs.getLong("heartbeatNext", 0);
        if (at == 0 || prefs.getString("heartbeatSession", "").isEmpty()) return false;
        String revision = prefs.getString("heartbeatRevision", "");
        boolean scheduled = schedule(context, selected, revision, at);
        armLocalWakeup(context, selected, revision, at, at);
        if (!scheduled) {
            prefs.edit().putBoolean("heartbeatFailed", true).putLong("heartbeatLast", System.currentTimeMillis())
                .putString("heartbeatResult", "安卓没有接受后台计划，前台或共享屏幕期间仍可唤醒").apply();
        }
        return scheduled;
    }

    static synchronized void resumeLocalSchedule(Context context) {
        for (String selected : PhoneToolsBridge.folderIds(context)) resumeLocalSchedule(context, selected);
    }

    private static void resumeLocalSchedule(Context context, String folderId) {
        SharedPreferences prefs = PhoneToolsBridge.prefs(context, folderId);
        long at = prefs.getLong("heartbeatNext", 0);
        if ((current == null || !current.folderId.equals(folderId)) && isEnabled(context, folderId)
                && at > 0 && !prefs.getString("heartbeatSession", "").isEmpty()) {
            String revision = prefs.getString("heartbeatRevision", "");
            if (context.getSystemService(JobScheduler.class).getPendingJob(jobId(folderId)) == null) {
                schedule(context, folderId, revision, at);
            }
            armLocalWakeup(context, folderId, revision, at, at);
        }
    }

    static synchronized void onClockChanged(Context context) {
        for (String selected : PhoneToolsBridge.folderIds(context)) {
            SharedPreferences prefs = PhoneToolsBridge.prefs(context, selected);
            String mode = prefs.getString("heartbeatMode", "");
            if (!isEnabled(context, selected) || (!"daily".equals(mode) && !"at".equals(mode))) continue;
            long dueAt = nextTime(mode, prefs.getString("heartbeatValue", ""), ZonedDateTime.now());
            if (dueAt == 0) continue;
            prefs.edit().putLong("heartbeatNext", dueAt).apply();
            enqueue(context, selected);
        }
    }

    private static boolean schedule(Context context, String folderId, String revision, long at) {
        return schedule(context, folderId, revision, at, at);
    }

    private static boolean schedule(Context context, String folderId, String revision, long at, long runAt) {
        String selected = PhoneToolsBridge.folder(folderId);
        PersistableBundle data = new PersistableBundle();
        data.putString("folderId", selected);
        data.putString("revision", revision);
        data.putLong("dueAt", at);
        try {
            JobInfo job = new JobInfo.Builder(jobId(selected), new ComponentName(context, HeartbeatJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(Math.max(0, runAt - System.currentTimeMillis()))
                .setPersisted(true).setExtras(data).build();
            return context.getSystemService(JobScheduler.class).schedule(job) == JobScheduler.RESULT_SUCCESS;
        } catch (RuntimeException failed) {
            return false;
        }
    }

    private static void clearLocalWakeup(String folderId) {
        if (localWakeup != null && PhoneToolsBridge.folder(folderId).equals(localWakeupFolder)) {
            MAIN.removeCallbacks(localWakeup);
            localWakeup = null;
            localWakeupFolder = null;
        }
    }

    private static void armLocalWakeup(Context context, String folderId, String revision, long dueAt, long runAt) {
        String selected = PhoneToolsBridge.folder(folderId);
        clearLocalWakeup(selected);
        if (localWakeup != null) MAIN.removeCallbacks(localWakeup);
        Context app = context.getApplicationContext();
        localWakeupFolder = selected;
        localWakeup = () -> {
            synchronized (HeartbeatJob.class) {
                if (!matches(app, selected, revision, dueAt)
                        || (!ScreenCaptureService.active() && !ChatWebView.isForeground())) return;
                if (current != null && !current.folderId.equals(selected)) {
                    armLocalWakeup(app, selected, revision, dueAt, System.currentTimeMillis() + 5_000);
                    return;
                }
                if (begin(app, null, null, selected, revision, dueAt)) {
                    app.getSystemService(JobScheduler.class).cancel(jobId(selected));
                }
            }
        };
        MAIN.postDelayed(localWakeup, Math.max(0, runAt - System.currentTimeMillis()));
    }

    private static boolean matches(Context context, String folderId, String revision, long dueAt) {
        SharedPreferences prefs = PhoneToolsBridge.prefs(context, folderId);
        return isEnabled(context, folderId) && revision.equals(prefs.getString("heartbeatRevision", ""))
            && dueAt == prefs.getLong("heartbeatNext", 0);
    }

    @Override public boolean onStartJob(JobParameters params) {
        synchronized (HeartbeatJob.class) {
            String selected = PhoneToolsBridge.folder(params.getExtras().getString("folderId", PhoneToolsBridge.DEFAULT_FOLDER));
            String revision = params.getExtras().getString("revision", "!");
            long dueAt = params.getExtras().getLong("dueAt");
            if (current != null && !current.folderId.equals(selected) && matches(this, selected, revision, dueAt)) {
                schedule(this, selected, revision, dueAt, System.currentTimeMillis() + 5_000);
                return false;
            }
            if (current == null && !matches(this, selected, revision, dueAt)) {
                MAIN.post(() -> enqueue(this, selected));
                return false;
            }
            return begin(getApplicationContext(), this, params, selected, revision, dueAt);
        }
    }

    private static boolean begin(Context context, HeartbeatJob job, JobParameters params,
            String folderId, String revision, long dueAt) {
        if (current != null || !matches(context, folderId, revision, dueAt)) return false;
        SharedPreferences prefs = PhoneToolsBridge.prefs(context, folderId);
        if (prefs.getString("heartbeatSession", "").isEmpty()) return false;
        clearLocalWakeup(folderId);
        try {
            Run run = new Run(context, job, params, prefs, folderId, revision, dueAt);
            current = run;
            run.page.startHeartbeat();
            MAIN.postDelayed(run.timeout, 180_000);
            return true;
        } catch (RuntimeException failed) {
            Run run = current;
            current = null;
            prefs.edit().putLong("heartbeatLast", System.currentTimeMillis())
                .putBoolean("heartbeatFailed", true).putString("heartbeatResult", "无法启动聊天页面").apply();
            if (run != null) run.page.finishHeartbeat();
            closeOccurrence(context, folderId, prefs.getString("heartbeatMode", ""), prefs.getString("heartbeatValue", ""),
                dueAt, prefs.getInt("heartbeatCount", 0) + 1);
            MAIN.post(() -> enqueue(context, folderId));
            return false;
        }
    }

    @Override public boolean onStopJob(JobParameters params) {
        synchronized (HeartbeatJob.class) {
            Run run = current;
            if (run == null || run.params != params) return false;
            current = null;
            MAIN.removeCallbacks(run.timeout);
            run.page.finishHeartbeat();
            boolean retry = matches(this, run.folderId, run.revision, run.dueAt);
            if (!retry && isEnabled(this, run.folderId)) MAIN.post(() -> enqueue(this, run.folderId));
            return retry;
        }
    }

    private static void closeOccurrence(Context context, String folderId,
            String mode, String value, long dueAt, int count) {
        SharedPreferences prefs = PhoneToolsBridge.prefs(context, folderId);
        if ("after".equals(mode) || "at".equals(mode)) {
            cancelSchedule(context, folderId, false);
            return;
        }
        ZonedDateTime now = ZonedDateTime.now();
        long next = nextTime(mode, value, now);
        if ("interval".equals(mode) && next > 0) {
            long interval = durationMillis(value);
            long elapsed = Math.max(0, now.toInstant().toEpochMilli() - dueAt);
            next = dueAt + (elapsed / interval + 1) * interval;
        }
        prefs.edit().putInt("heartbeatCount", count).putLong("heartbeatNext", next).apply();
    }

    private static void complete(Run run, String status, String result) {
        synchronized (HeartbeatJob.class) {
            if (current != run) return;
            current = null;
            MAIN.removeCallbacks(run.timeout);
            Context context = run.context;
            boolean enabled = isEnabled(context, run.folderId);
            boolean unchanged = matches(context, run.folderId, run.revision, run.dueAt);
            boolean retry = unchanged && "busy".equals(status);
            if (run.job != null) run.job.jobFinished(run.params, retry);
            if (enabled && !retry) {
                PhoneToolsBridge.prefs(context, run.folderId).edit()
                    .putLong("heartbeatLast", System.currentTimeMillis())
                    .putBoolean("heartbeatFailed", "error".equals(status))
                    .putString("heartbeatResult", result).apply();
                if ("done".equals(status) && !result.isEmpty()) notifyResult(context, result);
                if (unchanged) closeOccurrence(context, run.folderId, run.mode, run.value, run.dueAt, run.count);
                enqueue(context, run.folderId);
            } else if (retry) {
                long retryAt = System.currentTimeMillis() + 5_000;
                if (run.job == null) schedule(context, run.folderId, run.revision, run.dueAt, retryAt);
                armLocalWakeup(context, run.folderId, run.revision, run.dueAt, retryAt);
            }
        }
        run.page.finishHeartbeat();
    }

    public static final class Bridge {
        @JavascriptInterface public boolean isHeadless() { return ChatWebView.isHeadless(); }

        @JavascriptInterface public String pending() {
            Run run = current;
            if (run == null || !isEnabled(run.context, run.folderId)) return "null";
            try {
                return new JSONObject().put("id", run.id).put("folderId", run.folderId).put("at", run.at)
                    .put("sessionId", run.sessionId).put("task", run.task).put("dueAt", run.dueAt)
                    .put("count", run.count).put("mode", run.mode).put("value", run.value).toString();
            } catch (Exception invalid) {
                return "null";
            }
        }

        @JavascriptInterface public void complete(String id, String status, String result) {
            if (!"done".equals(status) && !"busy".equals(status) && !"error".equals(status)) return;
            if (result == null || result.length() > 4000) return;
            MAIN.post(() -> {
                Run run = current;
                if (run != null && run.id.equals(id)) HeartbeatJob.complete(run, status, result);
            });
        }
    }

    private static void notifyResult(Context context, String output) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (!manager.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Heartbeat", NotificationManager.IMPORTANCE_DEFAULT));
        Intent openChat = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(context, NOTIFICATION_ID, openChat,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        manager.notify(NOTIFICATION_ID, new Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Heartbeat")
            .setContentText(output)
            .setStyle(new Notification.BigTextStyle().bigText(output))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(open).setAutoCancel(true).build());
    }
}
