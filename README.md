<p align="center">
  <img src="logo.png" width="180" alt="TikTok Repost Ultimate" />
</p>

<h1 align="center">TikTok Repost Ultimate</h1>

<p align="center">
  <strong>Extension quản lý TikTok trên trình duyệt — bulk repost, yêu thích, follow, và tải nội dung</strong><br/>
  <sub>Phiên bản tiện ích: <b>4.5</b> · Manifest V3</sub>
</p>

<p align="center">
  <a href="https://github.com/kien234/tiktok-unrepost"><img src="https://img.shields.io/badge/GitHub-kien234%2Ftiktok--unrepost-181717?style=flat-square&logo=github" alt="Repo" /></a>
  <img src="https://img.shields.io/badge/Chrome-MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="MV3" />
  <img src="https://img.shields.io/badge/TikTok-tiktok.com-000000?style=flat-square&logo=tiktok&logoColor=white" alt="TikTok" />
  <img src="https://img.shields.io/badge/UI-Glassmorphism-25F4EE?style=flat-square" alt="UI" />
</p>

---

## Mục lục

- [Tại sao dùng TRU?](#tại-sao-dùng-tru)
- [Tính năng chính](#tính-năng-chính)
- [Tải video & ảnh (carousel / photo)](#tải-video--ảnh-carousel--photo)
- [Cài đặt](#cài-đặt)
- [Sử dụng nhanh](#sử-dụng-nhanh)
- [Hiệu năng & giới hạn](#hiệu-năng--giới-hạn)
- [Quyền & bảo mật](#quyền--bảo-mật)
- [Tác giả](#tác-giả)

---

## Tại sao dùng TRU?

**TikTok Repost Ultimate (TRU)** chạy ngay trên [tiktok.com](https://www.tiktok.com): gom thao tác lặp lại (xoá repost, gỡ favorite, luồng hủy follow) vào một panel kéo được, có **delay chỉnh theo giây** để giảm rủi ro hành vi gắng quá nhanh.

Giao diện **glass / dark** có thể thu nhỏ thành icon; tab **Tải** cố gắng lấy URL từ JSON feed (`item_list` / hydration) và hỗ trợ **bài ảnh** `/photo/…`.

---

## Tính năng chính

| | Mô tả |
|---|-----|
| **Bulk xóa Repost** | Duyệt danh sách repost và xóa theo luồng có delay |
| **Gỡ favorite hàng loạt** | Hỗ trợ queue mở tab (autounfav) |
| **Hủy follow (flow)** | Nút hướng dẫn cuộn + hủy với delay đồng bộ Settings |
| **Dashboard** | Follower / following / like (theo DOM & cache trang khi có) |
| **Nhịp âm nhạc (pulse)** | Phân tích Web Audio sau **một cử chỉ người dùng** (Chrome policy) |
| **Tối ưu hiệu năng** | Debounce làm mới panel, cache chọn video, giảm gán filter mỗi frame |

---

## Tải video & ảnh (carousel / photo)

- **Video:** ưu tiên URL từ metadata (`download_addr` / `play_addr`…); không có có thể thử luồng blob / `currentSrc`.
- **Ảnh:** metadata `image_post_info` / carousel; không có có thể gom `img` lớn từ CDN trên **trang `/photo/…`** hoặc bài ảnh ( `aweme_type` tương thích).

> TikTok có thể trả watermark / URL hết hạn. Extension chỉ tái dùng link mà trang/SDK cung cấp — không bypass DRM hay server riêng.

---

## Cài đặt

### Google Chrome / Chromium

1. Clone hoặc tải zip repo này.
2. Mở `chrome://extensions/`.
3. Bật **Developer mode**.
4. **Load unpacked** → chọn thư mục dự án (chứa `manifest.json`).
5. (Tuỳ chọn) **Pin** extension lên thanh công cụ.

### Microsoft Edge

Tương tự qua `edge://extensions/` → **Load unpacked**.

---

## Sử dụng nhanh

1. **Đăng nhập** TikTok trên trình duyệt (version web).
2. Mở hồ sơ / FYP tuỳ tính năng — panel TRU hiện sau khi tương tác hoặc theo nhịp kích hoạt extension.
3. Chọn tab **RP / Fav / Tải / FL / Set** và thao tác theo nhãn.
4. **Delay:** chỉnh trong **Settings** (và Tab FL đồng bộ delay unfollow).

**Gợi ý:** delay **1.2–2.5 s** hoặc cao hơn nếu tài khoản thường bị giới hạn hành động.

---

## Hiệu năng & giới hạn

- Code inject chạy trên `tiktok.com`; đã **giảm tần suất** quét DOM (`video`, link) và **gộp** làm mới panel khi có nhiều response feed.
- Nếu máy yếu: thu nhỏ panel hoặc tắt tab không dùng; tránh chồng extension chỉnh DOM khác cùng trang TikTok.

---

## Quyền & bảo mật

- Extension chỉ khai báo **content scripts** cho `*.tiktok.com` (theo `manifest.json`).
- Không mô tả dịch vụ backend trong repo — toàn bộ logic chính nằm ở `inject.js` và script đi kèm.
- Người dùng chịu trách nhiệm tuân thủ Điều khoản TikTok và pháp luật địa phương.

---

## Tác giả

**Nguyễn Văn Kiên**

<p>
  <a href="https://web.facebook.com/vnkien.06"><img src="https://img.shields.io/badge/Facebook-vnkien.06-1877F2?style=flat-square&logo=facebook&logoColor=white" alt="Facebook" /></a>
  <a href="https://www.instagram.com/_vnkien.09/"><img src="https://img.shields.io/badge/Instagram-_vnkien.09-E4405F?style=flat-square&logo=instagram&logoColor=white" alt="Instagram" /></a>
</p>

---

<p align="center">
  <b>Repository:</b> <a href="https://github.com/kien234/tiktok-unrepost">github.com/kien234/tiktok-unrepost</a><br/>
  <sub>© 2024–2026 Nguyễn Văn Kiên</sub>
</p>
