package local.deepseek.chat;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/** A small persistent ball; the existing WebView is attached only to a minimal reply box. */
final class FloatingChatWindow {
    private static final int GLASS = 0xeb0c0d14;
    private final MainActivity activity;
    private final ChatWebView chat;
    private final WindowManager manager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private LinearLayout ball, panel;
    private TextView preview;
    private LinearLayout guide;
    private ObservationButtonView observationButton;
    private FloatingOrbView icon;
    private WindowManager.LayoutParams layout, panelLayout, previewLayout;
    private boolean inputFocused, expanded, unread;
    private boolean voiceReady, voiceGesture, voiceHeld;
    private String voiceRun;
    private FloatingVoiceRecording recording;
    private byte[] recordedAudio;
    private boolean recordingFinished;
    private String latestText = "", latestSession = "", latestRun = "";
    private final Runnable dismissPreview = this::hidePreview;
    private final Runnable voiceUnavailable = this::showVoiceUnavailable;
    private static FloatingChatWindow currentWindow;

    FloatingChatWindow(MainActivity activity, ChatWebView chat) {
        this.activity = activity; this.chat = chat;
        manager = activity.getSystemService(WindowManager.class);
    }
    boolean isShowing() { return ball != null; }

    void show() {
        if (isShowing() || !Settings.canDrawOverlays(activity)) return;
        ball = new LinearLayout(activity);
        ball.setGravity(Gravity.CENTER_VERTICAL);
        ball.setElevation(dp(6));
        icon = new FloatingOrbView(activity);
        icon.setContentDescription(activity.getString(R.string.floating_chat_ball));
        ball.addView(icon, new LinearLayout.LayoutParams(dp(48), dp(48)));
        observationButton = new ObservationButtonView(activity);
        observationButton.setOnClickListener(view -> toggleObservation());
        ball.addView(observationButton, new LinearLayout.LayoutParams(dp(40), dp(48)));
        GestureDetector gestures = new GestureDetector(activity, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent e) { return true; }
            @Override public boolean onSingleTapUp(MotionEvent e) { icon.ripple(); return true; }
            @Override public boolean onSingleTapConfirmed(MotionEvent e) {
                icon.performClick();
                if (!expanded && !latestText.isEmpty()) showPreview();
                return true;
            }
            @Override public boolean onDoubleTap(MotionEvent e) { icon.ripple(); togglePanel(); return true; }
            @Override public void onLongPress(MotionEvent e) { beginVoiceHold(); }
        });
        icon.setOnTouchListener(new View.OnTouchListener() {
            float x, y; int startX, startY; boolean dragging;
            @Override public boolean onTouch(View view, MotionEvent event) {
                if (layout == null) return false;
                if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                    x = event.getRawX(); y = event.getRawY(); startX = layout.x; startY = layout.y; dragging = false;
                    voiceGesture = false;
                }
                if (voiceGesture) {
                    int action = event.getActionMasked();
                    if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                        gestures.onTouchEvent(event);
                        if (voiceHeld) {
                            voiceHeld = false;
                            if (action == MotionEvent.ACTION_CANCEL) cancelVoice();
                            else finishVoiceHold();
                        }
                    } else if (action == MotionEvent.ACTION_POINTER_DOWN) {
                        cancelVoice();
                    }
                    return true;
                }
                if (event.getActionMasked() == MotionEvent.ACTION_MOVE &&
                        Math.hypot(event.getRawX() - x, event.getRawY() - y) > dp(8)) {
                    if (!dragging) {
                        MotionEvent cancel = MotionEvent.obtain(event); cancel.setAction(MotionEvent.ACTION_CANCEL);
                        gestures.onTouchEvent(cancel); cancel.recycle();
                    }
                    dragging = true;
                    layout.x = startX + Math.round(event.getRawX() - x);
                    layout.y = startY + Math.round(event.getRawY() - y);
                    place(); return true;
                }
                if (!dragging) gestures.onTouchEvent(event);
                return true;
            }
        });
        panel = new LinearLayout(activity) {
            @Override public boolean dispatchTouchEvent(MotionEvent event) {
                if (event.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                    if (!inputFocused && voiceRun == null) collapse();
                    return false;
                }
                return super.dispatchTouchEvent(event);
            }
            @Override public void onWindowFocusChanged(boolean focused) {
                super.onWindowFocusChanged(focused);
                if (focused && inputFocused) {
                    chat.view.requestFocus();
                    activity.getSystemService(InputMethodManager.class).showSoftInput(chat.view, InputMethodManager.SHOW_IMPLICIT);
                }
            }
            @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) {
                if (event.getKeyCode() == android.view.KeyEvent.KEYCODE_BACK) {
                    if (event.getAction() == android.view.KeyEvent.ACTION_UP) collapse();
                    return true;
                }
                return super.dispatchKeyEvent(event);
            }
        };
        panel.setOrientation(LinearLayout.VERTICAL);
        // Dark frosted glass; the page inside is transparent while floating so this shows through.
        panel.setBackground(shape(GLASS, 16)); panel.setClipToOutline(true); panel.setElevation(dp(8));
        LinearLayout bar = new LinearLayout(activity); bar.setGravity(Gravity.CENTER_VERTICAL);
        TextView full = label("↗"); full.setContentDescription(activity.getString(R.string.floating_chat_expand));
        full.setOnClickListener(view -> activity.returnFromFloatingChat());
        bar.addView(full, new LinearLayout.LayoutParams(dp(36), dp(30)));
        bar.addView(new View(activity), new LinearLayout.LayoutParams(0, 0, 1));
        TextView more = label("⋯");
        more.setContentDescription(activity.getString(R.string.floating_chat_menu));
        more.setOnClickListener(view -> menu(view));
        bar.addView(more, new LinearLayout.LayoutParams(dp(36), dp(30)));
        TextView close = label("−"); close.setTextSize(20);
        close.setContentDescription(activity.getString(R.string.floating_chat_collapse));
        close.setOnClickListener(view -> collapse());
        bar.addView(close, new LinearLayout.LayoutParams(dp(36), dp(30)));
        panel.addView(bar);
        layout = params(dp(88), dp(48));
        Rect screen = bounds(); layout.x = screen.width() - dp(100); layout.y = screen.height() / 2;
        panelLayout = params(Math.min(dp(260), screen.width() - dp(16)), Math.min(dp(230), screen.height() - dp(64)));
        panelLayout.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        try { manager.addView(ball, layout); }
        catch (RuntimeException unavailable) { ball = null; panel = null; chat.notifyFloatingChat("unavailable"); return; }
        hideKeyboard(); detachWebView();
        chat.view.setBackgroundColor(Color.TRANSPARENT);
        panel.addView(chat.view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        currentWindow = this;
        place();
        chat.notifyFloatingChat("open"); refreshObservation();
        prepareVoice(ball);
    }

    private boolean microphoneAllowed() {
        return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void prepareVoice(View currentBall) {
        if (microphoneAllowed()) {
            // Android grants while-in-use microphone access when the service starts from a visible activity.
            Intent service = new Intent(activity, FloatingVoiceService.class)
                .putExtra(FloatingVoiceService.READY_CALLBACK, new ResultReceiver(main) {
                    @Override protected void onReceiveResult(int result, Bundle data) {
                        finishOpening(currentBall, result == 1);
                    }
                });
            try {
                activity.startForegroundService(service);
                return;
            } catch (RuntimeException unavailable) { /* The overlay can still display chats. */ }
        }
        finishOpening(currentBall, false);
    }

    private void finishOpening(View openedBall, boolean ready) {
        if (ball != openedBall) return;
        voiceReady = ready;
        if (activity.moveTaskToBack(true)) showGuide();
        else restore();
    }

    private void beginVoiceHold() {
        voiceGesture = true;
        if (voiceRun != null) return;
        hideGuide();
        if (!microphoneAllowed()) {
            activity.requestFloatingMicrophone();
            return;
        }
        if (!voiceReady) {
            showVoiceUnavailable();
            return;
        }
        focusInput(false);
        voiceHeld = true;
        voiceRun = UUID.randomUUID().toString();
        icon.setVoiceState("starting");
        main.postDelayed(voiceUnavailable, 3000);
        chat.requestFloatingVoice("start", voiceRun);
    }

    void voiceState(String runId, String status) {
        if (voiceRun == null || !voiceRun.equals(runId) || status == null) return;
        switch (status) {
            case "rejected":
                showPanel();
                status = "idle";
                // Fall through to free the rejected hold.
            case "idle":
                if (recording != null) recording.cancel();
                recording = null;
                recordedAudio = null;
                recordingFinished = false;
                chat.setFloatingAudio(null, null);
                voiceRun = null;
                voiceHeld = false;
                break;
            case "starting":
                if (voiceHeld && recording == null) startRecording(runId);
                break;
            case "transcribing": break;
            default: return;
        }
        main.removeCallbacks(voiceUnavailable);
        icon.setVoiceState(status);
    }

    private void startRecording(String runId) {
        recording = new FloatingVoiceRecording();
        recording.start(
            () -> main.post(() -> {
                if (runId.equals(voiceRun) && voiceHeld) icon.setVoiceState("recording");
            }),
            wav -> main.post(() -> {
                if (!runId.equals(voiceRun)) return;
                recordedAudio = wav;
                recordingFinished = true;
                if (!voiceHeld) publishVoice(runId);
                else icon.setVoiceState("ready");
            }),
            () -> main.post(() -> { if (runId.equals(voiceRun)) showVoiceUnavailable(); }));
    }

    private void finishVoiceHold() {
        if (recording == null) {
            cancelVoice();
            return;
        }
        recording.finish();
        if (recordingFinished) publishVoice(voiceRun);
    }

    private void publishVoice(String runId) {
        byte[] wav = recordedAudio;
        recordedAudio = null;
        showPanel();
        if (wav == null) {
            chat.requestFloatingVoice("empty", runId);
        } else {
            chat.setFloatingAudio(runId, wav);
            icon.setVoiceState("transcribing");
            chat.requestFloatingVoice("audio", runId);
        }
    }

    private void showVoiceUnavailable() {
        cancelVoice();
        Toast.makeText(activity, R.string.floating_voice_unavailable, Toast.LENGTH_SHORT).show();
    }

    private void cancelVoice() {
        if (voiceRun == null) return;
        String runId = voiceRun;
        voiceState(runId, "idle");
        chat.requestFloatingVoice("cancel", runId);
    }

    void receive(String session, String run, String text, boolean currentChat) {
        if (!isShowing() || run.equals(latestRun) || text.trim().isEmpty() || text.trim().equals("HEARTBEAT_OK")) return;
        latestSession = session; latestRun = run; latestText = text.length() > 600 ? text.substring(0, 600) : text;
        unread = !expanded || !currentChat;
        icon.setUnread(unread);
        if (unread) showPreview();
    }

    private void togglePanel() {
        if (expanded) { collapse(); return; }
        // A received message may belong to a background observation chat. Select it only on user open.
        if (unread && !latestSession.isEmpty()) chat.view.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('android-floating-session',{detail:" + JSONObject.quote(latestSession) + "}))", null);
        unread = false; icon.setUnread(false);
        showPanel();
    }

    private boolean showPanel() {
        if (expanded) return true;
        hideGuide();
        hidePreview();
        try {
            manager.addView(panel, panelLayout); expanded = true; place();
        }
        catch (RuntimeException failed) { expanded = false; }
        return expanded;
    }
    private void collapse() {
        cancelVoice();
        focusInput(false);
        if (panel != null && panel.isAttachedToWindow()) manager.removeViewImmediate(panel);
        expanded = false;
    }
    void refreshObservation() {
        if (!isShowing()) return;
        boolean enabled = PhoneToolsBridge.prefs(activity).getBoolean("ocr", false);
        observationButton.setObserving(enabled);
    }
    private void toggleObservation() {
        boolean enabled = PhoneToolsBridge.prefs(activity).getBoolean("ocr", false);
        if (enabled) chat.phoneTools.setEnabled("ocr", false);
        chat.requestObservation(enabled ? "stop" : "start");
        refreshObservation();
    }
    private void menu(View anchor) {
        PopupMenu menu = new PopupMenu(activity, anchor);
        menu.getMenu().add(activity.getString(R.string.floating_chat_capture_preview)).setOnMenuItemClickListener(item -> {
            if (!expanded) togglePanel();
            chat.view.evaluateJavascript("window.dispatchEvent(new Event('android-capture-preview'))", null);
            return true;
        });
        menu.getMenu().add(activity.getString(R.string.floating_chat_close)).setOnMenuItemClickListener(item -> { restore(); return true; });
        menu.show();
    }
    private void showPreview() {
        hidePreview(); if (!isShowing() || guide != null || latestText.isEmpty()) return;
        preview = label(latestText); preview.setGravity(Gravity.TOP | Gravity.LEFT);
        preview.setMaxLines(4);
        preview.setEllipsize(android.text.TextUtils.TruncateAt.END);
        preview.setPadding(dp(12), dp(10), dp(12), dp(10)); preview.setBackground(shape(GLASS, 14));
        preview.setElevation(dp(6)); preview.setOnClickListener(view -> {
            if (expanded) collapse();
            togglePanel();
        });
        previewLayout = params(Math.min(dp(230), bounds().width() - dp(16)), WindowManager.LayoutParams.WRAP_CONTENT);
        try { manager.addView(preview, previewLayout); place(); main.postDelayed(dismissPreview, 8000); }
        catch (RuntimeException failed) { preview = null; }
    }
    private void hidePreview() {
        main.removeCallbacks(dismissPreview);
        if (preview != null && preview.isAttachedToWindow()) manager.removeViewImmediate(preview);
        preview = null;
    }

    private void showGuide() {
        android.content.SharedPreferences preferences = activity.getSharedPreferences("floating_chat", Context.MODE_PRIVATE);
        if (preferences.getBoolean("gesture_guide_shown", false)) return;
        guide = new LinearLayout(activity);
        guide.setOrientation(LinearLayout.VERTICAL);
        guide.setPadding(dp(16), dp(12), dp(16), dp(8));
        guide.setBackground(shape(GLASS, 16));
        guide.setElevation(dp(8));
        TextView actions = label(activity.getString(R.string.floating_chat_guide));
        actions.setGravity(Gravity.LEFT);
        actions.setLineSpacing(dp(6), 1);
        guide.addView(actions);
        TextView done = label(activity.getString(R.string.floating_chat_guide_done));
        done.setTextColor(FloatingOrbView.GOLD);
        done.setOnClickListener(view -> hideGuide());
        guide.addView(done, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)));
        WindowManager.LayoutParams coachLayout = params(Math.min(dp(285), bounds().width() - dp(16)),
            WindowManager.LayoutParams.WRAP_CONTENT);
        coachLayout.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        coachLayout.y = dp(16);
        try {
            manager.addView(guide, coachLayout);
            preferences.edit().putBoolean("gesture_guide_shown", true).apply();
        } catch (RuntimeException unavailable) { guide = null; }
    }

    private void hideGuide() {
        if (guide != null && guide.isAttachedToWindow()) manager.removeViewImmediate(guide);
        guide = null;
    }
    void restore() {
        if (!isShowing()) return;
        remove();
        activity.attachFullChat();
    }
    void remove() {
        if (!isShowing()) return;
        hideGuide(); hidePreview(); collapse(); hideKeyboard(); detachWebView();
        activity.stopService(new Intent(activity, FloatingVoiceService.class));
        voiceReady = false;
        chat.view.setBackgroundColor(Color.WHITE);
        if (ball.isAttachedToWindow()) manager.removeViewImmediate(ball);
        ball = null; panel = null; layout = null; expanded = false; inputFocused = false;
        if (currentWindow == this) currentWindow = null;
        chat.notifyFloatingChat("closed");
    }
    void focusInput(boolean focused) {
        if (!expanded || inputFocused == focused) return;
        if (!focused) hideKeyboard(); inputFocused = focused;
        if (focused) {
            panelLayout.flags &= ~(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH);
        } else {
            panelLayout.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
        }
        placePanel(bounds());
        if (focused) chat.view.requestFocus();
        else chat.view.evaluateJavascript("document.activeElement?.blur()", null);
    }
    void resize() {
        if (!isShowing()) return;
        panelLayout.width = Math.min(dp(260), bounds().width() - dp(16));
        panelLayout.height = Math.min(dp(230), bounds().height() - dp(64)); place();
    }
    private void place() {
        if (!isShowing()) return;
        Rect screen = bounds();
        layout.x = Math.max(0, Math.min(layout.x, screen.width() - layout.width));
        layout.y = Math.max(0, Math.min(layout.y, screen.height() - layout.height - dp(32)));
        manager.updateViewLayout(ball, layout);
        placePanel(screen);
        if (preview != null) {
            previewLayout.x = Math.max(0, Math.min(layout.x, screen.width() - previewLayout.width));
            previewLayout.y = Math.max(0, Math.min(screen.height() - dp(130),
                layout.y >= dp(136) ? layout.y - dp(130) : layout.y + dp(54)));
            manager.updateViewLayout(preview, previewLayout);
        }
    }

    private void placePanel(Rect screen) {
        panelLayout.x = Math.max(0, Math.min(layout.x, screen.width() - panelLayout.width));
        if (inputFocused) {
            // Anchor the focusable panel to the bottom of the available area above the IME.
            panelLayout.gravity = Gravity.BOTTOM | Gravity.LEFT | Gravity.CLIP_VERTICAL;
            panelLayout.y = dp(6);
        } else {
            panelLayout.gravity = Gravity.TOP | Gravity.LEFT;
            int nearBall = layout.y >= panelLayout.height ? layout.y - panelLayout.height - dp(6) : layout.y + dp(54);
            panelLayout.y = Math.max(0, Math.min(nearBall, screen.height() - panelLayout.height));
        }
        if (Build.VERSION.SDK_INT >= 30) {
            int fit = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout();
            panelLayout.setFitInsetsTypes(inputFocused ? fit | WindowInsets.Type.ime() : fit);
        }
        if (expanded) manager.updateViewLayout(panel, panelLayout);
    }
    /** Snapshot on the main thread. These bounds filter OCR text without modifying the screenshot. */
    static List<RectF> observationRegions() {
        FloatingChatWindow window = currentWindow;
        if (window == null) return Collections.emptyList();
        Rect screen = Build.VERSION.SDK_INT >= 30
            ? window.manager.getMaximumWindowMetrics().getBounds() : window.bounds();
        if (screen.isEmpty()) return Collections.emptyList();

        List<RectF> regions = new ArrayList<>(4);
        int[] at = new int[2];
        for (View view : new View[]{window.ball, window.expanded ? window.panel : null, window.preview, window.guide}) {
            if (view == null || !view.isShown() || view.getWidth() == 0 || view.getHeight() == 0) continue;
            view.getLocationOnScreen(at);
            float x = (at[0] - screen.left) / (float) screen.width();
            float y = (at[1] - screen.top) / (float) screen.height();
            regions.add(new RectF(x, y, x + view.getWidth() / (float) screen.width(),
                y + view.getHeight() / (float) screen.height()));
        }
        return regions;
    }

    private WindowManager.LayoutParams params(int width, int height) {
        WindowManager.LayoutParams result = new WindowManager.LayoutParams(width, height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
            | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH, PixelFormat.TRANSLUCENT);
        result.gravity = Gravity.TOP | Gravity.LEFT; return result;
    }
    private Rect bounds() {
        if (Build.VERSION.SDK_INT >= 30) return manager.getCurrentWindowMetrics().getBounds();
        DisplayMetrics metrics = new DisplayMetrics(); manager.getDefaultDisplay().getRealMetrics(metrics);
        return new Rect(0, 0, metrics.widthPixels, metrics.heightPixels);
    }
    private GradientDrawable shape(int color, int radius) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius));
        shape.setStroke(Math.max(1, dp(1)), 0x29ffe4be); return shape;
    }
    private TextView label(String text) {
        TextView view = new TextView(activity); view.setText(text); view.setTextSize(14);
        view.setTextColor(0xfff1e8dc); view.setGravity(Gravity.CENTER); return view;
    }
    private void detachWebView() {
        if (chat.view.getParent() instanceof ViewGroup) ((ViewGroup) chat.view.getParent()).removeView(chat.view);
    }
    private void hideKeyboard() {
        if (chat.view.getWindowToken() != null) activity.getSystemService(InputMethodManager.class)
            .hideSoftInputFromWindow(chat.view.getWindowToken(), 0);
        chat.view.clearFocus();
    }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
}
