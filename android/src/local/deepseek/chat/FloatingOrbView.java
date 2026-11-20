package local.deepseek.chat;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.SweepGradient;
import android.view.View;
import android.view.animation.LinearInterpolator;

/**
 * A small black hole in a frosted glass bead: a tilted accretion disk crossing the horizon, and its far side
 * lensed into arcs above and below. Shaders are built on size change and frames only rotate them, so drawing
 * allocates nothing. An unread reply lights an ember on the rim.
 */
final class FloatingOrbView extends View {
    static final int EMBER = 0xffff7b42, GOLD = 0xffffc46b, CREAM = 0xfffff1d6, BLUE = 0xff8db4ff, VOID = 0xff05060b;
    private static final float TILT = 0.3f;
    private final Paint glass = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint rim = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint disk = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint lens = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint horizon = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint tapGlow = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint voicePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF oval = new RectF();
    private final Matrix spin = new Matrix();
    private final ValueAnimator motion = ValueAnimator.ofFloat(0f, 1f);
    private final ValueAnimator tap = ValueAnimator.ofFloat(0f, 1f);
    private final float density;
    private SweepGradient diskShader, lensShader;
    private float phase, pressed = 1f;
    private String voiceState = "idle";
    private boolean unread;

    FloatingOrbView(Context context) {
        super(context);
        density = getResources().getDisplayMetrics().density;
        rim.setStyle(Paint.Style.STROKE);
        disk.setStyle(Paint.Style.STROKE);
        disk.setStrokeCap(Paint.Cap.ROUND);
        lens.setStyle(Paint.Style.STROKE);
        lens.setStrokeCap(Paint.Cap.ROUND);
        ring.setStyle(Paint.Style.STROKE);
        ring.setColor(CREAM);
        tapGlow.setStyle(Paint.Style.STROKE);
        tapGlow.setColor(CREAM);
        voicePaint.setStyle(Paint.Style.STROKE);
        voicePaint.setStrokeCap(Paint.Cap.ROUND);
        horizon.setColor(VOID);
        motion.setDuration(9000);
        motion.setRepeatCount(ValueAnimator.INFINITE);
        motion.setInterpolator(new LinearInterpolator());
        motion.addUpdateListener(value -> { phase = (float) value.getAnimatedValue(); invalidate(); });
        tap.setDuration(520);
        tap.addUpdateListener(value -> { pressed = (float) value.getAnimatedValue(); invalidate(); });
    }

    void setUnread(boolean value) { unread = value; invalidate(); }

    void ripple() {
        if (!"idle".equals(voiceState) || !ValueAnimator.areAnimatorsEnabled()) return;
        tap.cancel();
        tap.start();
    }

    void setVoiceState(String state) {
        if (voiceState.equals(state)) return;
        voiceState = state;
        if (!"idle".equals(state)) {
            tap.cancel();
            pressed = 1f;
        }
        int description;
        switch (state) {
            case "starting": description = R.string.floating_voice_preparing; break;
            case "recording": description = R.string.floating_voice_recording; break;
            case "ready": description = R.string.floating_voice_ready; break;
            case "transcribing": description = R.string.floating_voice_transcribing; break;
            default: description = R.string.floating_chat_ball;
        }
        setContentDescription(getContext().getString(description));
        invalidate();
    }

    @Override protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        float cx = w / 2f, cy = h / 2f, r = Math.min(cx, cy);
        glass.setShader(new RadialGradient(cx, cy * 0.86f, r, new int[]{0xf01a1b27, 0xf00c0d14, 0xf0090a10},
            new float[]{0f, 0.7f, 1f}, Shader.TileMode.CLAMP));
        rim.setShader(new SweepGradient(cx, cy,
            new int[]{0x8cfff1d6, 0x1afff1d6, 0x59ffc46b, 0x1afff1d6, 0x8cfff1d6}, null));
        // The approaching side runs hot white-gold into ember; the receding edge cools toward blue.
        diskShader = new SweepGradient(cx, cy, new int[]{EMBER, GOLD, CREAM, GOLD, EMBER, 0x80ff7b42, BLUE, EMBER},
            new float[]{0f, 0.14f, 0.26f, 0.38f, 0.55f, 0.7f, 0.84f, 1f});
        lensShader = new SweepGradient(cx, cy, new int[]{0x40ff7b42, GOLD, CREAM, GOLD, 0x40ff7b42}, null);
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (diskShader == null) return;
        float cx = getWidth() / 2f, cy = getHeight() / 2f;
        float r = Math.min(cx, cy) - density * 2f;
        if (!"idle".equals(voiceState)) {
            drawVoice(canvas, cx, cy, r);
            return;
        }
        float breath = (float) (0.5 - 0.5 * Math.cos(phase * Math.PI * 4));
        float squeeze = pressed < 1f ? (float) Math.sin(pressed * Math.PI) : 0f;
        float hole = r * 0.34f * (1f + 0.18f * squeeze);
        float diskR = r * 0.74f * (1f - 0.12f * squeeze);

        canvas.drawCircle(cx, cy, r, glass);
        rim.setStrokeWidth(density);
        canvas.drawCircle(cx, cy, r - density * 0.5f, rim);

        spin.setRotate(phase * 360f, cx, cy);
        diskShader.setLocalMatrix(spin);
        disk.setShader(diskShader);
        spin.setRotate(-phase * 220f, cx, cy);
        lensShader.setLocalMatrix(spin);
        lens.setShader(lensShader);

        // Far side of the disk, lensed over the top of the horizon and faintly under it.
        float bend = hole * 1.38f, width = r * 0.085f;
        oval.set(cx - bend, cy - bend, cx + bend, cy + bend);
        lens.setStrokeWidth(width * 2.6f);
        lens.setAlpha(36);
        canvas.drawArc(oval, 180f, 180f, false, lens);
        lens.setStrokeWidth(width);
        lens.setAlpha(165 + (int) (70 * breath));
        canvas.drawArc(oval, 180f, 180f, false, lens);
        lens.setAlpha(70);
        canvas.drawArc(oval, 20f, 140f, false, lens);

        disk.setStrokeWidth(r * 0.16f);
        disk.setAlpha(190);
        oval.set(cx - diskR, cy - diskR * TILT, cx + diskR, cy + diskR * TILT);
        canvas.drawArc(oval, 180f, 180f, false, disk);

        canvas.drawCircle(cx, cy, hole, horizon);
        ring.setStrokeWidth(density * 2.6f);
        ring.setAlpha(46);
        canvas.drawCircle(cx, cy, hole + density * 0.6f, ring);
        ring.setStrokeWidth(density * 0.9f);
        ring.setAlpha(170 + (int) (70 * breath));
        canvas.drawCircle(cx, cy, hole + density * 0.6f, ring);

        // The near side of the disk crosses in front of the horizon.
        disk.setAlpha(255);
        canvas.drawArc(oval, 0f, 180f, false, disk);

        if (squeeze > 0f) {
            tapGlow.setStrokeWidth(density * (1f + 1.8f * squeeze));
            tapGlow.setAlpha((int) (235 * (1f - pressed)));
            canvas.drawCircle(cx, cy, r - (r - hole) * pressed, tapGlow);
        }
        if (unread) {
            float ux = cx + r * 0.72f, uy = cy - r * 0.72f;
            dot.setColor(EMBER);
            canvas.drawCircle(ux, uy, density * 3.4f, dot);
            dot.setColor(CREAM);
            canvas.drawCircle(ux, uy, density * 1.4f, dot);
        }
    }

    private void drawVoice(Canvas canvas, float cx, float cy, float radius) {
        canvas.drawCircle(cx, cy, radius, glass);
        float frame = radius - density * 2f;
        voicePaint.setStrokeWidth(density * 2f);
        if ("recording".equals(voiceState)) {
            voicePaint.setColor(0xfffd6e74);
            canvas.drawCircle(cx, cy, frame, voicePaint);
            for (int bar = -2; bar <= 2; bar++) {
                float x = cx + bar * density * 4f;
                float pulse = (float) (0.65 + 0.35 * Math.sin(phase * Math.PI * 18 + bar * 0.9));
                float height = (4f - Math.abs(bar)) * density * pulse;
                canvas.drawLine(x, cy - height, x, cy + height, voicePaint);
            }
            return;
        }
        voicePaint.setColor(0x30ffc46b);
        canvas.drawCircle(cx, cy, frame, voicePaint);
        voicePaint.setColor("transcribing".equals(voiceState) ? GOLD : BLUE);
        oval.set(cx - frame, cy - frame, cx + frame, cy + frame);
        canvas.drawArc(oval, phase * 2880f, 105, false, voicePaint);
    }

    private void updateMotion() {
        if (isAttachedToWindow() && isShown() && getWindowVisibility() == VISIBLE && ValueAnimator.areAnimatorsEnabled()) {
            if (motion.isPaused()) motion.resume(); else if (!motion.isStarted()) motion.start();
        } else if (motion.isStarted()) { motion.pause(); }
    }
    @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); updateMotion(); }
    @Override protected void onDetachedFromWindow() {
        motion.cancel(); tap.cancel(); pressed = 1f;
        super.onDetachedFromWindow();
    }
    @Override protected void onVisibilityChanged(View changedView, int visibility) {
        super.onVisibilityChanged(changedView, visibility);
        if (motion != null) updateMotion();
    }
    @Override protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(visibility);
        if (motion != null) updateMotion();
    }
}
