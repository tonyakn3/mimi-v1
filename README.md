# Mimi V2.0 — Reset Loop

Kiến trúc mới được làm lại để đúng một vòng lặp đơn giản và không giữ hội thoại cũ.

1. Người 1 nói bằng Ngôn ngữ 1.
2. Người dùng nói **“Mimi nói”**.
3. Mimi dịch Ngôn ngữ 1 → Ngôn ngữ 2 và đọc bản dịch.
4. Mimi **xóa toàn bộ audio/bộ nhớ của lượt vừa xong**.
5. Người 2 nói bằng Ngôn ngữ 2.
6. Người dùng nói **“dịch lại”**.
7. Mimi dịch Ngôn ngữ 2 → Ngôn ngữ 1 và đọc bản dịch.
8. Mimi **xóa toàn bộ audio/bộ nhớ của lượt vừa xong** rồi quay về bước 1.

## Điểm khác V1.x

- Không còn Gemini Live session kéo dài.
- Không còn transcript/conversation context tích lũy qua nhiều lượt.
- Mỗi lượt dịch là một request stateless chỉ chứa audio của lượt hiện tại.
- Sau khi đọc xong: local audio buffer được xóa sạch; server không lưu session hội thoại.
- Lệnh chiều ngược đổi hẳn thành **“dịch lại”**, không còn chung tiền tố “Mimi”.

## Deploy Render

Giữ `Health Check Path` là `/api/health`.

Environment Variable:

`GEMINI_API_KEY = <key của bạn>`

Không upload `.env` lên GitHub.
