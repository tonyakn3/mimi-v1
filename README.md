# Mimi V1 — Phiên dịch hội thoại 2 chiều trên iPhone Safari

Mimi là PWA phiên dịch giọng nói cho 2 người ngồi đối diện nhau. Giao diện giữ đúng phong cách sáng đã chốt, chỉ cần chọn 2 ngôn ngữ rồi bấm **BẮT ĐẦU**.

## Quy tắc hoạt động đã được code

- **Mimi nói**: Người 1 → Người 2.
- **Mimi dịch**: Người 2 → Người 1.
- Mimi nghe liên tục nhưng chỉ phát bản dịch sau khi nghe một trong hai lệnh trên.
- Câu lệnh không được đưa vào nội dung dịch.
- Trong lúc Mimi phát giọng, app ngừng gửi microphone lên API để tránh nghe lại chính mình.
- Mic bật `echoCancellation`, `noiseSuppression`, `autoGainControl`, high-pass filter, adaptive noise gate và server-side VAD ở mức ít nhạy hơn để giảm tạp âm xa.
- Dịch theo nghĩa tự nhiên, không dịch từng chữ; giữ số liệu, giá tiền, model, thương hiệu và thuật ngữ.
- Có sẵn glossary màn hình LED và các cụm như P2.5, cabinet, receiving card, NovaStar, refresh rate, 3840Hz...
- Hiểu cách nói đời thường/miền Nam như `xài`, `hông`, `mắc`, `tao bao` thông qua system instruction.
- Khi đầu ra là tiếng Việt, system instruction yêu cầu phong cách phụ nữ miền Nam, tự nhiên và chuyên nghiệp. Voice mặc định hiện là `Kore` và có thể đổi trong `public/js/app.js`.

## Công nghệ

- Frontend: HTML/CSS/Vanilla JS, không framework.
- PWA: manifest + service worker + icon iPhone.
- Audio input: Web Audio API → PCM 16-bit / 16 kHz.
- AI: `gemini-3.1-flash-live-preview` qua Gemini Live API.
- Auth: API key chỉ nằm ở backend; frontend nhận **ephemeral token** ngắn hạn.
- Backend: Node.js 20+, không cần thư viện npm ngoài.

## Cấu trúc

```text
mimi-v1/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  ├─ manifest.webmanifest
│  ├─ service-worker.js
│  ├─ icons/
│  └─ js/
│     ├─ app.js
│     ├─ audio.js
│     └─ commands.js
├─ tests/
├─ server.mjs
├─ package.json
└─ .env.example
```

## 1. Lấy Gemini API key

1. Mở Google AI Studio: https://aistudio.google.com/
2. Vào **API Keys**.
3. Tạo key mới.
4. Không dán key vào `index.html` hoặc `app.js`.

Khi chạy server, tạo biến môi trường:

### Windows PowerShell

```powershell
$env:GEMINI_API_KEY="DAN_KEY_CUA_BAN_VAO_DAY"
npm start
```

### macOS / Linux

```bash
export GEMINI_API_KEY="DAN_KEY_CUA_BAN_VAO_DAY"
npm start
```

Mở trên máy tính: `http://localhost:3000`

> Localhost chỉ phù hợp để test trên chính máy tính. Muốn microphone hoạt động ổn định trên iPhone, hãy deploy bằng HTTPS.

## 2. Deploy để chạy trên Safari iPhone

Cách dễ nhất là đưa toàn bộ repo này lên GitHub rồi tạo một **Node Web Service** ở Render, Railway, Cloud Run hoặc một host Node.js tương đương.

Thiết lập:

- Start command: `npm start`
- Node: 20+
- Environment variable: `GEMINI_API_KEY=<key của bạn>`
- Không cần build command.

Sau khi deploy, host sẽ cấp một URL HTTPS, ví dụ:

```text
https://mimi-xxxx.example.com
```

Trên iPhone:

1. Mở URL bằng Safari.
2. Bấm **BẮT ĐẦU** và cho phép microphone.
3. Nhấn **Chia sẻ** → **Thêm vào Màn hình chính** để dùng như app.

## 3. Cách test

Chọn:

- Người 1: Tiếng Việt
- Người 2: Tiếng Trung

Nói:

```text
Giá này cao lắm, sản phẩm của mày có gì tốt hơn thằng kia? Mimi nói
```

Mimi phải đọc bản dịch tiếng Trung tự nhiên.

Sau đó đối tác nói tiếng Trung, bạn nói:

```text
Mimi dịch
```

Mimi phải đọc lại tiếng Việt.

## 4. Những điểm cần test thật trên iPhone

Phần code, command detector và server đã có test tự động, nhưng chất lượng phiên dịch thật còn phụ thuộc microphone, môi trường ồn, Gemini preview model và voice. Khi có API key và URL HTTPS, nên test thực tế các tình huống sau:

- Quán cà phê/triển lãm có tiếng người xung quanh.
- Người nói cách máy 0.5–1.5 m.
- Câu dài 20–60 giây.
- Số tiền/model khó nghe.
- Tiếng Việt miền Nam, câu nói tắt và tiếng lóng.
- Việt + Anh + thuật ngữ LED trộn trong cùng câu.

## 5. Bảo mật

`GEMINI_API_KEY` chỉ tồn tại ở server. Endpoint `/api/live-token` tạo token ngắn hạn, có rate limit và origin check cơ bản. Nếu sau này Mimi mở cho nhiều khách hàng công cộng, cần thêm đăng nhập/quota theo user để tránh người ngoài dùng hết quota API.

## Kiểm tra project

```bash
npm run check
npm test
```
