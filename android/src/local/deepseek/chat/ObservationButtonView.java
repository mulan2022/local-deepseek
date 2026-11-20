package local.deepseek.chat;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;

/** Compact play/pause artwork inside a larger touch target: a glass bead that fills with ember while observing. */
final class ObservationButtonView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path play = new Path();
    private boolean observing;

    ObservationButtonView(Context context) {
        super(context); setClickable(true); setFocusable(true);
        edge.setStyle(Paint.Style.STROKE);
    }

    void setObserving(boolean value) {
        if (observing == value && getContentDescription() != null) return;
        observing = value;
        String label = getContext().getString(value ? R.string.floating_chat_stop_ocr : R.string.floating_chat_start_ocr);
        setContentDescription(label); setTooltipText(label); invalidate();
    }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float d = getResources().getDisplayMetrics().density;
        float cx = getWidth() / 2f, cy = getHeight() / 2f;
        float radius = Math.min(14 * d, Math.min(cx, cy) - d);
        paint.setColor(observing ? FloatingOrbView.EMBER : 0xf00c0d14); paint.setAlpha(isPressed() ? 190 : 240);
        canvas.drawCircle(cx, cy, radius, paint);
        edge.setStrokeWidth(d);
        edge.setColor(observing ? FloatingOrbView.GOLD : FloatingOrbView.EMBER);
        edge.setAlpha(observing ? 200 : 170);
        canvas.drawCircle(cx, cy, radius - d * 0.5f, edge);
        paint.setColor(observing ? FloatingOrbView.VOID : FloatingOrbView.CREAM); paint.setAlpha(255);
        if (observing) {
            canvas.drawRoundRect(cx - 5*d, cy - 5*d, cx - 1.5f*d, cy + 5*d, d*.6f, d*.6f, paint);
            canvas.drawRoundRect(cx + 1.5f*d, cy - 5*d, cx + 5*d, cy + 5*d, d*.6f, d*.6f, paint);
        } else {
            play.rewind(); play.moveTo(cx - 3*d, cy - 5*d);
            play.lineTo(cx + 5*d, cy); play.lineTo(cx - 3*d, cy + 5*d); play.close();
            canvas.drawPath(play, paint);
        }
    }
    @Override protected void drawableStateChanged() { super.drawableStateChanged(); invalidate(); }
    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName("android.widget.Button"); info.setCheckable(true); info.setChecked(observing);
    }
}
