package local.deepseek.chat;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

/** Records PCM on a worker thread. The caller decides when to publish the result. */
final class FloatingVoiceRecording {
    private static final int SAMPLE_RATE = 16000;
    private static final int BYTES_PER_SECOND = SAMPLE_RATE * 2;
    private static final int MAX_BYTES = BYTES_PER_SECOND * 120;
    private static final int CHANNEL = AudioFormat.CHANNEL_IN_MONO;
    private static final int FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private volatile boolean finished, cancelled;

    void start(Runnable recording, Consumer<byte[]> completed, Runnable failed) {
        new Thread(() -> {
            byte[] wav;
            try {
                wav = capture(recording);
            } catch (RuntimeException error) {
                if (!cancelled) {
                    Log.w("FloatingVoiceRecording", "Could not record floating voice input", error);
                    failed.run();
                }
                return;
            }
            if (!cancelled) completed.accept(wav);
        }, "floating-voice-recorder").start();
    }

    void finish() { finished = true; }
    void cancel() { cancelled = true; finished = true; }

    private byte[] capture(Runnable recording) {
        if (finished) return null;
        int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, FORMAT);
        if (minimum <= 0) throw new IllegalStateException("Unsupported microphone format");
        byte[] buffer = new byte[2048];
        AudioRecord input = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE, CHANNEL, FORMAT, Math.max(minimum, buffer.length * 2));
        ByteArrayOutputStream pcm = new ByteArrayOutputStream(BYTES_PER_SECOND);
        try {
            if (finished) return null;
            if (input.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("Microphone unavailable");
            input.startRecording();
            if (input.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                throw new IllegalStateException("Microphone did not start");
            }
            if (!finished) recording.run();
            while (!finished && pcm.size() < MAX_BYTES) {
                int count = input.read(buffer, 0, Math.min(buffer.length, MAX_BYTES - pcm.size()));
                if (count < 0) throw new IllegalStateException("AudioRecord.read failed: " + count);
                pcm.write(buffer, 0, count);
            }
        } finally {
            try {
                if (input.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) input.stop();
            } finally {
                input.release();
            }
        }
        return cancelled || pcm.size() < BYTES_PER_SECOND / 10 ? null : encodeWav(pcm.toByteArray());
    }

    static byte[] encodeWav(byte[] pcm) {
        return ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN)
            .put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length)
            .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16)
            .putShort((short) 1).putShort((short) 1).putInt(SAMPLE_RATE).putInt(BYTES_PER_SECOND)
            .putShort((short) 2).putShort((short) 16)
            .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length).put(pcm).array();
    }
}
