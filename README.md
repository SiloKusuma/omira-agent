# 🤖 Omira AI Agent

AI Agent dengan Telegram Bot menggunakan Groq API.

## Persyaratan

- Node.js v14 atau lebih tinggi
- Akun Telegram
- Akun Groq (https://console.groq.com/)

## Instalasi

1. Install dependencies:
```bash
npm install
```

2. Konfigurasi file `.env`:
   - Copy file `.env` dan isi dengan API keys Anda
   - `TELEGRAM_TOKEN`: Dapatkan dari @BotFather di Telegram
   - `GROQ_API_KEY`: Dapatkan dari https://console.groq.com/

## Menjalankan Bot

```bash
npm start
```

## Fitur

- 💬 **Chat dengan AI**: Tanya apapun menggunakan Groq API dengan model openai/gpt-oss-120b
- 🖥️ **Deteksi OS**: Otomatis mendeteksi sistem operasi (Windows/Linux/macOS)
- ⚠️ **Konfirmasi Hapus**: Saat disuruh menghapus file, akan selalu meminta konfirmasi terlebih dahulu
- 🔒 **Keamanan**: Perintah berbahaya memerlukan konfirmasi eksplisit

## Cara Penggunaan

1. Mulai bot dengan `/start`
2. Kirim pertanyaan atau perintah
3. Untuk menghapus file, gunakan format:
   - "hapus file di C:\Users\ASUS\Downloads\test.txt"
   - "delete file /home/user/test.txt"
4. Bot akan meminta konfirmasi sebelum menghapus

## Contoh Perintah

- "Apa kabar?"
- "Jelaskan tentang JavaScript"
- "hapus file di C:\Users\ASUS\Downloads\test.txt" (akan meminta konfirmasi)
