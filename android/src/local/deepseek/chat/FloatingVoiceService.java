package local.deepseek.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.ResultReceiver;

/** Keeps the microphone available to the WebView while the user is in floating mode. */
public final class FloatingVoiceService extends Service {
    static final String READY_CALLBACK = "voice_ready_callback";
    private static final String CHANNEL = "floating_voice";
    private static final int NOTIFICATION = 1843;

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        ResultReceiver callback = intent == null ? null : intent.getParcelableExtra(READY_CALLBACK);
        boolean ready = false;
        try {
            Notification notification = voiceNotification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIFICATION, notification);
            }
            ready = true;
        } catch (RuntimeException unavailable) {
            stopSelf(startId);
        }
        if (callback != null) callback.send(ready ? 1 : 0, null);
        return START_NOT_STICKY;
    }

    private Notification voiceNotification() {
        String title = getString(R.string.floating_voice_notification);
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent action = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
            .setContentTitle(title)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(action)
            .build();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
