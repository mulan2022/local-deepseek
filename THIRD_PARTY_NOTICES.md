# Offline OCR components

The Android OCR observer bundles the following components. Recognition runs on the
device; the OCR engine does not require Google Play services or an OCR cloud API.

- Tesseract4Android 4.9.0, by Adaptech and contributors:
  https://github.com/adaptech-cz/Tesseract4Android/tree/4.9.0
  Licensed under Apache License 2.0. The AAR includes Tesseract (Apache 2.0),
  Leptonica (BSD 2-Clause), IJG libjpeg and libpng (libpng license).
- Simplified Chinese and English models from tesseract-ocr/tessdata_fast,
  commit 87416418657359cb625c412a48b6e1d6d41c29bd:
  https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd
  Licensed under Apache License 2.0.

Downloads are pinned and SHA-256 checked by scripts/prepare-ocr.ps1.
Full license texts are in android/ocr-licenses and included in the APK's OCR assets.
