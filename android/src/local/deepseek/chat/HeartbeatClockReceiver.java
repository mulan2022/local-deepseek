package local.deepseek.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class HeartbeatClockReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        HeartbeatJob.onClockChanged(context);
    }
}
