# Mimi V1.5 – Command Tool Fix

Bản này sửa lỗi microphone có phản ứng nhưng lệnh **“Mimi dịch”** không được thực thi.

## Nguyên nhân
Thanh mic nháy chỉ chứng minh iPhone đang thu được âm thanh. Bản cũ vẫn phải chờ `inputAudioTranscription` của Gemini trả ra đúng chữ “Mimi dịch” rồi regex mới kích hoạt lệnh. Trong lượt Người 2 (ví dụ đang nói tiếng Trung), transcript của câu lệnh tiếng Việt có thể đến chậm, sai hoặc không xuất hiện.

## Sửa trong V1.5
- Giữ command detector cũ làm fallback.
- Thêm **Gemini Live Function Calling** cho đúng hai lệnh:
  - `mimi_speak` khi nghe “Mimi nói”
  - `mimi_translate` khi nghe “Mimi dịch”
- Gemini có thể kích hoạt lệnh trực tiếp từ audio, không còn phụ thuộc hoàn toàn vào dòng transcript hiển thị.
- Function call gửi cả `source_text` để chiều Người 2 -> Người 1 vẫn có nguồn dịch nếu transcription đến trễ.
- Vẫn không cho Gemini tự nói khi chưa có lệnh; client xác nhận tool call rồi mới gửi `[MIMI_EXECUTE]`.
- Bump service worker cache để iPhone lấy code mới.

## Chỉ cần thay 2 file trên GitHub
- `public/js/app.js`
- `public/service-worker.js`

Sau đó Commit, chờ Render deploy lại, đóng hẳn Safari/PWA trên iPhone và mở lại.
