(function () {
/**
 * TikTok Repost Ultimate v4.0
 * --------------------------
 * Công cụ quản lý TikTok chuyên nghiệp
 * Phát triển bởi: Nguyễn Văn Kiên (kien234)
 * Website: https://github.com/kien234
 *
 * Bản quyền thuộc về Nguyễn Văn Kiên. Vui lòng không sao chép trái phép.
 */
    const originalFetch = window.fetch;
    window.allRepostVideos = [];
    window.allFollowing = [];
    window.allFavorites = [];
    window.allLikedVideos = [];
    /** Map id → aweme/item object (đổ metadata từ API feed trên trang) */
    window.truAwemeById = Object.create(null);
    window.truAwemeIdQueue = [];
    window.tiktokExtensionActivated = false;
    window.tiktokLastUrlObj = null;

    // --- LOGIC WORKER ---
    if (window.location.search.includes('autounfav=1')) {
        const showT = (m) => {
            const t = document.createElement('div');
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);backdrop-filter:blur(10px);color:#FE2C55;padding:12px 24px;border-radius:30px;z-index:999999;font-weight:800;border:1px solid #FE2C55;box-shadow:0 0 25px rgba(254,44,85,0.4);';
            t.innerText = '✨ ' + m; document.body.appendChild(t);
            setTimeout(() => t.remove(), 2500);
        };
        const tryU = async () => {
            await new Promise(r => setTimeout(r, 4000));
            const info = getUserInfo();
            if (!info.loggedIn) {
                if (window.location.search.includes('autounfav=1')) {
                    showT("Đợi đăng nhập...");
                    setTimeout(tryU, 2000);
                }
                return;
            }
            if (!window._notifiedLogin) { showT("Bạn đã đăng nhập!"); window._notifiedLogin = true; }
            const fav = document.querySelector('[data-e2e="favorite-icon"]');
            if (fav) {
                const b = fav.closest('button');
                if (fav.querySelector('path[fill="#FACE15"]')) {
                    b.click(); showT("Đã bỏ Yêu thích!");
                    const id = window.location.pathname.split('/').pop();
                    localStorage.setItem('tiktok_unfav_done_id', id + '_' + Date.now());
                    await new Promise(r => setTimeout(r, 3000));
                }
                let q = JSON.parse(localStorage.getItem('tiktok_unfav_queue') || '[]');
                if (q.length > 0) {
                    const next = q.shift(); localStorage.setItem('tiktok_unfav_queue', JSON.stringify(q));
                    window.location.href = `https://www.tiktok.com/@user/video/${next}?autounfav=1`;
                } else { showT("Hoàn tất!"); setTimeout(() => window.close(), 1500); }
            } else { setTimeout(tryU, 1500); }
        };
        tryU(); return;
    }

    // --- UTILS ---
    const TRU_CACHE_KEY = 'tiktok_extension_verified_user';

    function getCachedUserProfile() {
        try {
            const r = localStorage.getItem(TRU_CACHE_KEY);
            if (!r) return null;
            return JSON.parse(r);
        } catch (e) {
            return null;
        }
    }

    function getPageKind() {
        const path = window.location.pathname || '/';
        const isProfilePath = /^\/@[^/]+(\/)?$/.test(path);
        if (!isProfilePath) return 'feed';
        const editBtn = document.querySelector('[data-e2e="edit-profile-entrance"]') ||
            document.querySelector('button[class*="Edit"]');
        return editBtn ? 'own' : 'other';
    }

    /** Tránh quét toàn bộ DOM `video` 60fps — gây lag khi TikTok preload nhiều clip */
    let _truBestVidCache = null;
    let _truBestVidScanAt = 0;
    const TRU_BEST_VIDEO_SCAN_MS = 350;
    /** Chọn video TikTok đang phát, ưu tiên khung hình lớn trong viewport. `force`= true bỏ cache (tải, F5…) */
    function findBestFeedVideo(force) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!force && _truBestVidCache && typeof document !== 'undefined' && document.contains(_truBestVidCache)) {
            if (now - _truBestVidScanAt < TRU_BEST_VIDEO_SCAN_MS) return _truBestVidCache;
        }
        _truBestVidScanAt = now;
        const videos = Array.from(document.querySelectorAll('video'));
        let best = null;
        let bestArea = 0;
        for (const v of videos) {
            if (v.readyState < 2) continue;
            const r = v.getBoundingClientRect();
            if (r.width < 80 || r.height < 80) continue;
            const top = Math.max(r.top, 0);
            const bottom = Math.min(r.bottom, window.innerHeight);
            const visibleH = Math.max(0, bottom - top);
            if (visibleH < 40) continue;
            const area = r.width * visibleH;
            if (!v.paused && area > bestArea) {
                bestArea = area;
                best = v;
            }
        }
        if (best) {
            _truBestVidCache = best;
            return best;
        }
        for (const v of videos) {
            if (!v.paused && v.readyState >= 2) {
                _truBestVidCache = v;
                return v;
            }
        }
        _truBestVidCache = videos[0] || null;
        return _truBestVidCache;
    }

    /** Gộp nhiều feed JSON chỉ làm một lần cập nhật panel → giảm jank */
    let _truDebouncedPanelRefreshTimer = null;
    function scheduleRefreshTruViewerPanel() {
        if (_truDebouncedPanelRefreshTimer != null) clearTimeout(_truDebouncedPanelRefreshTimer);
        _truDebouncedPanelRefreshTimer = setTimeout(() => {
            _truDebouncedPanelRefreshTimer = null;
            refreshTruViewerPanel();
        }, 420);
    }

    const TRU_AWEME_CACHE_MAX = 500;

    function truNormalizeAwemeId(item) {
        if (!item) return '';
        const id = item.aweme_id ?? item.awemeId ?? item.id ?? item.stats?.aweme_id;
        return id != null && String(id).trim() !== '' ? String(id).trim() : '';
    }

    function truIngestAwemeItems(items) {
        if (!Array.isArray(items) || !items.length) return;
        const q = window.truAwemeIdQueue;
        const map = window.truAwemeById;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const id = truNormalizeAwemeId(item);
            if (!id) continue;
            const wasNew = !(id in map);
            map[id] = item;
            if (wasNew) q.push(id);
        }
        while (q.length > TRU_AWEME_CACHE_MAX) {
            const rm = q.shift();
            if (rm != null) delete map[rm];
        }
    }

    /** URL API TikTok thường trả itemList chứa play_addr / download_addr / image_post_info */
    function truIsLikelyAwemeFeedApi(fullUrl) {
        if (!fullUrl || typeof fullUrl !== 'string') return false;
        let u = fullUrl;
        try {
            if (!/^https?:\/\//i.test(u)) u = new URL(u, location.origin).href;
        } catch (e) { return false; }
        if (!/\/api\//i.test(u)) return false;
        if (/item_list/i.test(u)) return true;
        return /\/api\/(recommend|feed|following|homepage|browse|related|challenge|music|explore|poi|discovery|general|friend|business)\b/i.test(u);
    }

    function truExtractItemListsFromPayload(d) {
        const out = [];
        if (!d || typeof d !== 'object') return out;
        if (Array.isArray(d.itemList)) out.push(d.itemList);
        if (Array.isArray(d.item_list)) out.push(d.item_list);
        if (Array.isArray(d.items)) out.push(d.items);
        if (d.aweme_detail && typeof d.aweme_detail === 'object') out.push([d.aweme_detail]);
        const data = d.data;
        if (data && typeof data === 'object') {
            if (Array.isArray(data.itemList)) out.push(data.itemList);
            if (Array.isArray(data.item_list)) out.push(data.item_list);
            if (Array.isArray(data.items)) out.push(data.items);
        }
        return out;
    }

    function truProcessFeedJsonPayload(d) {
        const lists = truExtractItemListsFromPayload(d);
        for (let i = 0; i < lists.length; i++) truIngestAwemeItems(lists[i]);
        scheduleRefreshTruViewerPanel();
    }

    /** Quét state nhúng (SIGI / hydration) — giúp có metadata ngay, không cần chỉ fetch/XHR. */
    let _truLastEmbedHarvest = 0;
    const TRU_EMBED_HARVEST_MS = 8000;
    function truHarvestEmbeddedPageState() {
        const now = Date.now();
        if (now - _truLastEmbedHarvest < TRU_EMBED_HARVEST_MS) return;
        _truLastEmbedHarvest = now;

        let budget = 6000;
        const visited = new WeakSet();
        function walk(o, depth) {
            if (budget-- <= 0 || depth > 14 || !o || typeof o !== 'object') return;
            if (visited.has(o)) return;
            visited.add(o);

            const il = o.itemList || o.item_list;
            if (Array.isArray(il) && il.length > 0) {
                const first = il[0];
                if (first && (first.video || first.aweme_id || first.id
                    || first.image_post_info || first.imagePost)) {
                    truIngestAwemeItems(il);
                }
            }
            if (o.aweme_detail && typeof o.aweme_detail === 'object') {
                const ad = o.aweme_detail;
                if (ad.video || ad.id || ad.aweme_id) truIngestAwemeItems([ad]);
            }

            const keys = Object.keys(o);
            if (keys.length > 100) return;
            for (let i = 0; i < keys.length; i++) {
                const v = o[keys[i]];
                if (v && typeof v === 'object') walk(v, depth + 1);
            }
        }

        try {
            const roots = [
                typeof window.SIGI_STATE !== 'undefined' ? window.SIGI_STATE : null,
                typeof window.__UNIVERSAL_DATA_FOR_REHYDRATION__ !== 'undefined' ? window.__UNIVERSAL_DATA_FOR_REHYDRATION__ : null,
            ];
            for (let r = 0; r < roots.length; r++) {
                if (roots[r]) walk(roots[r], 0);
            }
        } catch (e) { /* ignore */ }

        try {
            const scripts = document.querySelectorAll('script[id]');
            for (let i = 0; i < scripts.length; i++) {
                const el = scripts[i];
                const id = (el.id || '').toUpperCase();
                if (!/SIGI|UNIVERSAL|NEXT_DATA|SLARDAR/i.test(id)) continue;
                const txt = el.textContent || '';
                if (txt.length < 80 || !/itemList|aweme/i.test(txt)) continue;
                try {
                    truProcessFeedJsonPayload(JSON.parse(txt));
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    }

    const _truXhrOpen = XMLHttpRequest.prototype.open;
    const _truXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try {
            this._truReqUrl = typeof url === 'string' ? url : '';
        } catch (e) {
            this._truReqUrl = '';
        }
        return _truXhrOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function (...sendArgs) {
        this.addEventListener('load', function truOnXhrLoad() {
            this.removeEventListener('load', truOnXhrLoad);
            if (!truIsLikelyAwemeFeedApi(String(this._truReqUrl || ''))) return;
            const rt = this.responseType;
            if (rt && rt !== 'text' && rt !== '') return;
            const raw = this.responseText;
            if (!raw || typeof raw !== 'string') return;
            const txt = raw.trim();
            if (txt.charAt(0) !== '{') return;
            try {
                truProcessFeedJsonPayload(JSON.parse(txt));
            } catch (e) { /* ignore non-JSON */ }
        });
        return _truXhrSend.apply(this, sendArgs);
    };

    /** Lấy chuỗi URL đầu tiên từ playAddr/downloadAddr kiểu n8n (string hoặc object UrlList/url_list). */
    function truCoerceVideoUrlField(x) {
        if (!x) return null;
        if (typeof x === 'string' && /^https?:\/\//i.test(x)) return x;
        if (typeof x === 'object') {
            const arr = x.url_list || x.UrlList || x.URLList || x.urls;
            if (Array.isArray(arr)) {
                for (let i = 0; i < arr.length; i++) {
                    const s = arr[i];
                    if (typeof s === 'string' && /^https?:\/\//i.test(s)) return s;
                }
            }
        }
        return null;
    }

    /** Heuristic: không logo — download_addr hoặc play_addr, thử đổi playwm→play */
    function truPreferCleanerVideoUrl(u) {
        if (!u || typeof u !== 'string') return u;
        let s = u;
        if (/playwm/i.test(s)) {
            try {
                s = s.replace(/playwm/gi, 'play');
            } catch (e) { /* ignore */ }
        }
        return s;
    }

    function truPickVideoDownloadUrl(item) {
        const v = item?.video;
        if (!v || typeof v !== 'object') return null;
        const uDl = truCoerceVideoUrlField(v.download_addr)
            || truCoerceVideoUrlField(v.downloadAddr);
        if (uDl) return truPreferCleanerVideoUrl(uDl);
        const uPl = truCoerceVideoUrlField(v.play_addr)
            || truCoerceVideoUrlField(v.playAddr)
            || truCoerceVideoUrlField(v.PlayAddr);
        if (uPl) return truPreferCleanerVideoUrl(uPl);
        const br = v.bit_rate || v.bitrateInfo || v.BitrateInfo;
        if (Array.isArray(br) && br.length) {
            const sorted = [...br].sort((a, b) => (
                ((b.bit_rate || b.Bitrate || b.bitrate || 0)) - ((a.bit_rate || a.Bitrate || a.bitrate || 0))
            ));
            for (let i = 0; i < sorted.length; i++) {
                const cand = sorted[i];
                const u = truCoerceVideoUrlField(cand.play_addr || cand.PlayAddr || cand.playAddr);
                if (u) return truPreferCleanerVideoUrl(u);
            }
        }
        return null;
    }

    /** Một URL ảnh từ blob TikTok (display_image / image / url_list / uri…). */
    function truCoerceImageUrlCandidate(x) {
        if (!x) return null;
        if (typeof x === 'string' && /^https?:\/\//i.test(x)) return x;
        if (typeof x !== 'object') return null;
        const lists = [x.url_list, x.UrlList, x.URLList, x.urls, x.urlList];
        for (let j = 0; j < lists.length; j++) {
            const arr = lists[j];
            if (!Array.isArray(arr)) continue;
            for (let k = 0; k < arr.length; k++) {
                const s = arr[k];
                if (typeof s === 'string' && /^https?:\/\//i.test(s)) return s;
            }
        }
        const u = x.url || x.URL || x.uri || x.URI;
        return (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : null;
    }

    function truExtractPhotoUrls(item) {
        const ipi = item?.image_post_info || item?.imagePost || item?.ImagePost;
        const imgs = ipi?.images;
        if (!Array.isArray(imgs)) return [];
        const urls = [];
        for (let i = 0; i < imgs.length; i++) {
            const im = imgs[i];
            let u = truCoerceImageUrlCandidate(im?.display_image)
                || truCoerceImageUrlCandidate(im?.DisplayImage)
                || truCoerceImageUrlCandidate(im?.image)
                || truCoerceImageUrlCandidate(im?.Image)
                || truCoerceImageUrlCandidate(im);
            if (u) urls.push(u);
        }
        return urls;
    }

    /** Fallback: ảnh đang hiển thị trên DOM (/photo/ hoặc khi JSON không có carousel). */
    function truScrapePhotoUrlsFromDom() {
        const candidates = [];
        const reHost = /tiktokcdn|ibyteimg|byteimg|muscdn|akamaized|tiktok\.com\/obj|p16-sign|p77-sign/i;
        document.querySelectorAll('img[src*="http"], img[srcset]').forEach((img) => {
            const src = img.currentSrc || img.src;
            if (!src || !/^https?:\/\//i.test(src)) return;
            if (!reHost.test(src)) return;
            if (/avatar|profile|100x100|50x50|32x32|24x24|emoji|static\/web/i.test(src)) return;
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w < 140 && h < 140) return;
            candidates.push({ src, area: Math.max(1, w) * Math.max(1, h) });
        });
        candidates.sort((a, b) => b.area - a.area);
        const out = [];
        const seen = new Set();
        for (let i = 0; i < candidates.length; i++) {
            const s = candidates[i].src;
            if (seen.has(s)) continue;
            seen.add(s);
            out.push(s);
            if (out.length >= 24) break;
        }
        return out;
    }

    /** Ưu tiên metadata; nếu trống, quét DOM khi đang /photo/… hoặc item là bài ảnh. */
    function truMergePhotoDownloadUrls(item, path) {
        const meta = item ? truExtractPhotoUrls(item) : [];
        if (meta.length) return meta;
        const p = path || '';
        const onPhotoUrl = /\/photo\//i.test(p);
        const photoItem = !!(item && (item.image_post_info || item.imagePost || item.ImagePost
            || item.aweme_type === 150 || item.awemeType === 150));
        if (!onPhotoUrl && !photoItem) return [];
        return truScrapePhotoUrlsFromDom();
    }

    function truPhotoFilenameSuffix(url) {
        const m = String(url || '').match(/\.(jpe?g|png|webp)(?:\?|$)/i);
        if (m) {
            const e = m[1].toLowerCase();
            return e === 'jpeg' ? '.jpg' : `.${e}`;
        }
        return '.jpg';
    }

    /**
     * Gắn id video TikTok đang chiếm màn hình: URL /video/… hoặc link gần trục dọc video.
     */
    function findAwemeIdNearViewportVideo(video) {
        const path = window.location.pathname || '';
        const fromPath = path.match(/\/video\/(\d{8,})\b/) || path.match(/\/photo\/(\d{8,})\b/);
        if (fromPath && fromPath[1]) return fromPath[1];

        if (!video || !video.getBoundingClientRect) return null;
        const vr = video.getBoundingClientRect();
        if (vr.width < 10 || vr.height < 10) return null;
        const vc = (vr.top + vr.bottom) / 2;

        let bestId = null;
        let bestScore = 1e12;
        document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]').forEach((a) => {
            const m = String(a.href || '').match(/\/(?:video|photo)\/(\d{8,})\b/);
            if (!m) return;
            const r = a.getBoundingClientRect();
            const cy = (r.top + r.bottom) / 2;
            let score = Math.abs(cy - vc);
            const overlap = r.bottom >= vr.top - 120 && r.top <= vr.bottom + 120;
            if (!overlap) score += 8000;
            if (score < bestScore) {
                bestScore = score;
                bestId = m[1];
            }
        });

        try {
            const src = video.currentSrc || video.src || '';
            for (const k of Object.keys(window.truAwemeById)) {
                const it = window.truAwemeById[k];
                const play = truPickVideoDownloadUrl(it);
                if (!play || !src) continue;
                if (play.split('?')[0] === src.split('?')[0] || src.includes(play.slice(26, 80))) {
                    bestId = k;
                    break;
                }
            }
        } catch (e) { /* ignore */ }

        return bestId;
    }

    let _truFocusTupleCache = null;
    let _truFocusTupleAt = 0;
    const TRU_FOCUS_TUPLE_MS = 350;
    /** `opts.force` — khi bấm tải cần metadata chính xác, bỏ cache */
    function getTruFocusedAweme(opts) {
        const force = !!(opts && opts.force);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!force && _truFocusTupleCache && (now - _truFocusTupleAt) < TRU_FOCUS_TUPLE_MS) {
            const v = _truFocusTupleCache.video;
            if (!v || (typeof document !== 'undefined' && document.contains(v))) {
                return _truFocusTupleCache;
            }
        }
        const video = findBestFeedVideo(force);
        const id = findAwemeIdNearViewportVideo(video);
        const item = id ? window.truAwemeById[id] : null;
        const r = { video, awemeId: id, item };
        _truFocusTupleCache = r;
        _truFocusTupleAt = now;
        return r;
    }

    let _truLastHydrDetailMs = 0;
    /**
     * Cùng luồng n8n: parse __UNIVERSAL_DATA_FOR_REHYDRATION__
     * → __DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct → ingest cache.
     */
    function truTryIngestHydrationVideoDetail() {
        const now = Date.now();
        if (now - _truLastHydrDetailMs < 700) return;
        _truLastHydrDetailMs = now;
        let parsed = null;
        try {
            const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
            const raw = el && el.textContent ? el.textContent.trim() : '';
            if (raw && raw.charAt(0) === '{') parsed = JSON.parse(raw);
        } catch (e) {
            return;
        }
        if (!parsed || typeof parsed !== 'object') {
            try {
                const w = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
                if (w && typeof w === 'object') parsed = w;
            } catch (e2) { /* ignore */ }
        }
        if (!parsed || typeof parsed !== 'object') return;

        const scope = parsed.__DEFAULT_SCOPE__ || parsed.defaultScope;
        if (!scope || typeof scope !== 'object') return;
        const detail = scope['webapp.video-detail']
            || scope['webapp.video_detail']
            || scope['webapp.photo-detail']
            || scope['webapp.photo_detail'];
        if (!detail || typeof detail !== 'object') return;
        const itemStruct = detail.itemInfo?.itemStruct
            || detail.item_info?.itemStruct;
        if (!itemStruct || typeof itemStruct !== 'object') return;
        const nid = itemStruct.aweme_id || itemStruct.awemeId || itemStruct.id;
        if (nid == null || String(nid).trim() === '') return;

        const hasVid = !!(itemStruct.video && typeof itemStruct.video === 'object');
        const ipi = itemStruct.image_post_info || itemStruct.imagePost || itemStruct.ImagePost;
        const hasPhotos = !!(ipi && typeof ipi === 'object'
            && Array.isArray(ipi.images) && ipi.images.length > 0);
        if (!hasVid && !hasPhotos) return;

        truIngestAwemeItems([itemStruct]);
    }

    function truFormatCount(n) {
        if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
        const x = Number(n);
        if (x >= 1e9) return `${(x / 1e9).toFixed(1)}B`;
        if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
        if (x >= 1e3) return `${(x / 1e3).toFixed(1)}K`;
        return `${x}`;
    }

    async function truBlobDownload(fetchUrl, filename, statusEl, okLabel, errPrefix) {
        if (!fetchUrl) {
            if (statusEl) statusEl.textContent = errPrefix + 'Không có URL.';
            return false;
        }
        if (statusEl) statusEl.textContent = '⏳ Đang lấy tệp…';
        try {
            const isBlob = /^blob:/i.test(fetchUrl);
            const isTikTokish = /tiktok|byteoversea|akamaized|ttcdn|muscdn|ibyteimg/i.test(fetchUrl);
            const init = {
                credentials: isBlob ? 'same-origin' : 'include',
                mode: 'cors',
                referrer: typeof location !== 'undefined' ? location.href : undefined,
            };
            if (!isBlob && isTikTokish) {
                init.referrer = 'https://www.tiktok.com/';
            }
            const r = await originalFetch(fetchUrl, init);
            if (!r.ok) throw new Error(String(r.status));
            const blob = await r.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 9000);
            if (statusEl) statusEl.textContent = okLabel;
            return true;
        } catch (e) {
            if (statusEl) statusEl.textContent = errPrefix + 'Mở tab mới tải thử.';
            try {
                if (!/^blob:/i.test(fetchUrl)) window.open(fetchUrl, '_blank', 'noopener,noreferrer');
            } catch (e2) { }
            return false;
        }
    }

    function refreshTruViewerPanel() {
        truTryIngestHydrationVideoDetail();
        truHarvestEmbeddedPageState();

        const { awemeId, item, video } = getTruFocusedAweme();
        const sid = document.getElementById('tru-viewer-id');
        const dg = document.getElementById('tru-stat-digg');
        const cm = document.getElementById('tru-stat-comment');
        const sh = document.getElementById('tru-stat-share');
        const pl = document.getElementById('tru-stat-play');
        if (sid) {
            sid.textContent = item
                ? `ID · ${awemeId} · @${item.author?.uniqueId || '—'}`
                : awemeId
                    ? `ID · ${awemeId} (chưa có metadata — F5 hoặc đợi trang tải xong; ảnh dùng nút Tải ảnh)`
                    : video
                        ? 'Vuốt/đặt clip giữa màn — chưa xác định ID'
                        : /\/photo\//i.test(window.location.pathname || '')
                            ? 'Trang ảnh — đợi metadata hoặc F5'
                            : 'Không có video trên trang';
        }

        const cacheN = Object.keys(window.truAwemeById).length;
        const cacheEl = document.getElementById('tru-cache-count');
        if (cacheEl) {
            const onDetail = /\/video\/|\/photo\//i.test(window.location.pathname || '');
            cacheEl.textContent = cacheN > 0
                ? `Đã bắt metadata: ${cacheN} clip (API + hydration trang chi tiết nếu có)`
                : (onDetail
                    ? 'Đang chờ hydration __UNIVERSAL_DATA… — hoặc F5 trang video/ảnh'
                    : 'Chưa thấy gói item_list — vuốt FYP, hoặc mở /video/… hoặc /photo/…');
        }

        let digg = '—'; let comment = '—'; let share = '—'; let play = '—';
        const statObj = item && (item.stats || item.statistics);
        if (statObj && typeof statObj === 'object') {
            digg = truFormatCount(statObj.diggCount ?? statObj.digg_count);
            comment = truFormatCount(statObj.commentCount ?? statObj.comment_count);
            share = truFormatCount(statObj.shareCount ?? statObj.share_count);
            play = truFormatCount(statObj.playCount ?? statObj.play_count);
        }
        if (dg) dg.innerText = digg;
        if (cm) cm.innerText = comment;
        if (sh) sh.innerText = share;
        if (pl) pl.innerText = play;

        const ph = document.getElementById('tru-btn-dl-photos');
        const pathname = window.location.pathname || '';
        const photoUrls = truMergePhotoDownloadUrls(item, pathname);
        const showPhotoBtn = photoUrls.length > 0 || /\/photo\//i.test(pathname);
        if (ph) {
            ph.style.display = showPhotoBtn ? 'block' : 'none';
            ph.disabled = photoUrls.length === 0;
        }

        const vbtn = document.getElementById('tru-btn-dl-video');
        if (vbtn) {
            const hasMeta = !!(item && truPickVideoDownloadUrl(item));
            const vs = video && (video.currentSrc || video.src || '');
            const stream = !!(vs && (vs.startsWith('http') || /^blob:/i.test(vs)));
            vbtn.disabled = !hasMeta && !stream;
        }
    }

    function startTiktokMusicPulse() {
        if (window._truMusicPulseStarted) return;
        window._truMusicPulseStarted = true;

        const FFT = 512;
        let audioCtx = null;
        let analyser = null;
        /** Chrome: không tạo / nối Web Audio / resume context cho đến khi có cử chỉ người dùng */
        let truWebAudioUserGestured = false;
        if (!window._truWebAudioGestureInstalled) {
            window._truWebAudioGestureInstalled = true;
            const types = ['pointerdown', 'touchstart', 'keydown'];
            function onFirstUserGestureAudio() {
                truWebAudioUserGestured = true;
                try {
                    if (audioCtx && audioCtx.state === 'suspended') {
                        audioCtx.resume().catch(() => { });
                    }
                } catch (e) { /* ignore */ }
                for (let i = 0; i < types.length; i++) {
                    document.removeEventListener(types[i], onFirstUserGestureAudio, true);
                }
            }
            for (let i = 0; i < types.length; i++) {
                document.addEventListener(types[i], onFirstUserGestureAudio, { capture: true, passive: true });
            }
        }
        /** Nguồn Web Audio — MediaElementSource hoặc MediaStreamSource */
        let audioInputNode = null;
        /** Chỉ dùng với đường MES — cần nối tới destination để vẫn nghe được */
        let audioOutputGain = null;
        let lastVideo = null;
        /** Khi không tap được âm thanh — hạn chế spam Web Audio */
        let lastTapFailTs = 0;
        let lastTapFailVid = null;
        /** Chuẩn hoá nhịp: mượt nhưng vẫn bám transient */
        let displaySmooth = 1;
        /** Bao làm chậm để tính “nhảy” (onset / kick) */
        let slowSpectrumEnv = 0;
        /** Giảm tải CPU: phân tích/vẽ sóng ~30fps; filter vẫn mượt nhờ nội suy */
        let lastDriveSample = 0;
        let lastSampleAt = 0;
        /** Tránh gán `element.style.filter` mỗi frame khi khác biệt không đáng kể — giảm reflow/layout */
        let lastPulseFilterKey = '';
        const AUDIO_SAMPLE_INTERVAL_MS = 34;

        function resetEnvelope() {
            slowSpectrumEnv = 0;
            beatPeak = 0;
        }

        function resetBeatDynamics() {
            resetEnvelope();
            displaySmooth = 1;
        }

        function disconnectGraph() {
            try {
                if (audioOutputGain) {
                    audioOutputGain.disconnect();
                    audioOutputGain = null;
                }
                if (analyser) {
                    analyser.disconnect();
                    analyser = null;
                }
                if (audioInputNode) {
                    audioInputNode.disconnect();
                    audioInputNode = null;
                }
            } catch (e) { }
            resetEnvelope();
        }

        function createAnalyserNode() {
            const a = audioCtx.createAnalyser();
            a.fftSize = FFT;
            a.smoothingTimeConstant = 0.32;
            a.minDecibels = -85;
            a.maxDecibels = -18;
            return a;
        }

        /**
         * Thứ tự quan trọng cho âm thanh:
         * ① srcObject / captureStream — chỉ tap bản sao stream, KHÔNG cắt loa video.
         * ② createMediaElementSource — can thiệp pipeline (chỉ dùng khi ① thất bại).
         */
        function attachToVideo(video) {
            if (!video) return;
            if (!truWebAudioUserGestured) return;
            if (video === lastVideo && analyser) return;
            const backoff = Date.now() - lastTapFailTs < 900;
            if (!analyser && backoff && lastTapFailVid === video) return;

            disconnectGraph();
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => { });

            analyser = createAnalyserNode();

            const tryMediaElementTap = () => {
                try {
                    const mes = audioCtx.createMediaElementSource(video);
                    const g = audioCtx.createGain();
                    g.gain.value = 1;
                    mes.connect(analyser);
                    analyser.connect(g);
                    g.connect(audioCtx.destination);
                    audioInputNode = mes;
                    audioOutputGain = g;
                    return true;
                } catch (e) {
                    return false;
                }
            };

            const tryStreamTap = (stream) => {
                if (!stream || typeof stream.getAudioTracks !== 'function' || !stream.getAudioTracks().length) {
                    return false;
                }
                try {
                    const mss = audioCtx.createMediaStreamSource(stream);
                    mss.connect(analyser);
                    audioInputNode = mss;
                    audioOutputGain = null;
                    return true;
                } catch (e) {
                    return false;
                }
            };

            try {
                const so = video.srcObject;
                if (so instanceof MediaStream && tryStreamTap(so)) {
                    lastTapFailVid = null;
                    lastTapFailTs = 0;
                    lastVideo = video;
                    return;
                }
            } catch (e) { }

            if (typeof video.captureStream === 'function') {
                try {
                    const cap = video.captureStream();
                    if (tryStreamTap(cap)) {
                        lastTapFailVid = null;
                        lastTapFailTs = 0;
                        lastVideo = video;
                        return;
                    }
                } catch (e) { }
            }

            if (tryMediaElementTap()) {
                lastTapFailVid = null;
                lastTapFailTs = 0;
                lastVideo = video;
                return;
            }

            disconnectGraph();
            lastTapFailVid = video;
            lastTapFailTs = Date.now();
            lastVideo = null;
        }

        const freqBuf = new Uint8Array(FFT / 2);
        let timeWaveBuf = null;
        const FFT_BARS = 24;

        /**
         * Năng lượng dải tần (kick ~40–220 Hz, xung low-mid ~220–900 Hz).
         * Thêm spectral-flux nhẹ để nhấn vào đúng lúc trống/snare đập.
         */
        function computeBeatDrive() {
            if (!analyser || !audioCtx) return 0;

            analyser.getByteFrequencyData(freqBuf);
            const sr = audioCtx.sampleRate;
            const hz = sr / FFT;
            const n = analyser.frequencyBinCount;

            const band = (loHz, hiHz) => {
                let a = Math.max(1, Math.floor(loHz / hz));
                let b = Math.min(n - 1, Math.ceil(hiHz / hz));
                if (b < a) return { avg: 0, mx: 0 };
                let sum = 0;
                let mx = 0;
                for (let i = a; i <= b; i++) {
                    const v = freqBuf[i];
                    sum += v;
                    if (v > mx) mx = v;
                }
                const cnt = b - a + 1;
                return { avg: (sum / cnt) / 255, mx: mx / 255 };
            };

            const kick = band(45, 220);
            const punch = band(220, 950);
            const air = band(2000, 6500);

            const body = kick.avg * 0.55 + punch.avg * 0.32 + air.avg * 0.13;
            const spike = kick.mx * 0.62 + punch.mx * 0.38;
            let instant = body * 0.42 + spike * 0.58;

            slowSpectrumEnv = slowSpectrumEnv * 0.90 + instant * 0.10;
            const onset = Math.max(0, instant - slowSpectrumEnv * 1.08);
            instant = Math.min(1, instant + onset * 2.1);

            if (instant > beatPeak) beatPeak = instant;
            else beatPeak *= 0.87;

            return Math.min(1, beatPeak * 0.92 + onset * 0.45);
        }

        /** Vẽ oscilloscope + thanh FFT lên canvas (mini icon + panel) */
        function paintMusicWaves(timeBuf, specBuf, hasAnalyser, beatNorm) {
            const mini = document.getElementById('tru-mini-wave-canvas');
            const wrap = document.getElementById('tru-panel-wave-wrap');
            const panel = document.getElementById('tru-panel-wave-canvas');

            function clearCnvs(cvs) {
                if (!cvs) return;
                const ctx = cvs.getContext('2d');
                if (ctx && cvs.width) ctx.clearRect(0, 0, cvs.width, cvs.height);
            }

            if (!hasAnalyser || !timeBuf || timeBuf.length < 8 || !mini) {
                if (wrap) wrap.style.display = 'none';
                clearCnvs(panel);
                clearCnvs(mini);
                return;
            }

            if (wrap && panel) {
                const uiRoot = document.getElementById('tiktok-repost-ui');
                const panelOpen = !!(uiRoot && uiRoot.style.display !== 'none');
                wrap.style.display = panelOpen ? 'block' : 'none';
                if (!panelOpen) clearCnvs(panel);
            }

            const drawOne = (canvas, isMini) => {
                if (!canvas || !canvas.getContext) return;
                const dpr = Math.min(2.5, window.devicePixelRatio || 1);
                const rectW = canvas.clientWidth || (isMini ? 50 : 280);
                const rectH = canvas.clientHeight || (isMini ? 22 : 38);
                const tw = Math.max(48, Math.floor(rectW * dpr));
                const th = Math.max(12, Math.floor(rectH * dpr));
                if (canvas.width !== tw || canvas.height !== th) {
                    canvas.width = tw;
                    canvas.height = th;
                }
                const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
                    || canvas.getContext('2d');
                if (!ctx) return;
                const n = timeBuf.length;

                ctx.clearRect(0, 0, tw, th);
                ctx.fillStyle = isMini ? 'rgba(11,13,26,0.55)' : 'rgba(13,17,38,0.62)';
                ctx.fillRect(0, 0, tw, th);

                const midY = th * 0.42;
                const amp = th * (isMini ? 0.28 : 0.34) * (0.72 + beatNorm * 0.58);
                const step = Math.max(1, Math.floor(n / (tw / (dpr * 1.85))));

                const gx = ctx.createLinearGradient(0, 0, tw, 0);
                gx.addColorStop(0, `rgba(37,244,238,${0.38 + beatNorm * 0.45})`);
                gx.addColorStop(0.5, `rgba(254,44,85,${0.55 + beatNorm * 0.32})`);
                gx.addColorStop(1, `rgba(167,139,250,${0.4 + beatNorm * 0.38})`);

                ctx.beginPath();
                let px = -1;
                for (let i = 0; i < n; i += step) {
                    const x = (i / Math.max(1, n - 1)) * tw;
                    const v = (timeBuf[i] - 128) / 128;
                    const y = midY + v * amp;
                    if (px < 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    px = x;
                }
                ctx.strokeStyle = gx;
                ctx.lineWidth = Math.max(1.1, dpr * (isMini ? 1.05 : 1.28));
                ctx.lineJoin = 'round';
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(0, th);
                for (let i = 0; i < n; i += step) {
                    const x = (i / Math.max(1, n - 1)) * tw;
                    const v = (timeBuf[i] - 128) / 128;
                    const y = midY + v * amp;
                    ctx.lineTo(x, y);
                }
                ctx.lineTo(tw, th);
                ctx.closePath();
                ctx.fillStyle = `rgba(254,44,85,${0.07 + beatNorm * 0.15})`;
                ctx.fill();

                if (specBuf && specBuf.length > FFT_BARS + 16) {
                    const bars = FFT_BARS;
                    const pad = Math.max(1.5, dpr);
                    const totalW = tw - pad * 2;
                    const barGap = pad * 0.35;
                    const bw = Math.max(1.2, (totalW - barGap * (bars - 1)) / bars);
                    const bhMax = Math.max(3, (th - midY - pad * 2) * 0.95);
                    let x0 = pad;
                    const loIx = Math.max(4, Math.floor(specBuf.length * 0.02));

                    const barGradTop = '#25F4EE';
                    const barGradBot = '#FE2C55';

                    for (let b = 0; b < bars; b++) {
                        const r0 = loIx + Math.floor((specBuf.length - loIx - 8) * b / bars);
                        const r1 = loIx + Math.floor((specBuf.length - loIx - 8) * (b + 0.92) / bars);
                        let peak = 0;
                        for (let j = r0; j <= r1 && j < specBuf.length; j++) if (specBuf[j] > peak) peak = specBuf[j];

                        let hPx = bhMax * Math.pow(peak / 255, 0.75) * (0.55 + beatNorm * 0.45);

                        ctx.fillStyle = (() => {
                            const g = ctx.createLinearGradient(0, th - pad - hPx, 0, th - pad);
                            g.addColorStop(0, barGradTop);
                            g.addColorStop(1, barGradBot);
                            return g;
                        })();
                        const fy = Math.max(midY + pad * 0.75, th - pad - hPx);
                        const fh = Math.min(hPx, Math.max(0, th - pad - fy));

                        ctx.fillRect(x0, fy, bw, fh);
                        x0 += bw + barGap;
                    }
                }
            };

            drawOne(mini, true);
            const uiRootDraw = document.getElementById('tiktok-repost-ui');
            if (panel && uiRootDraw && uiRootDraw.style.display !== 'none') {
                drawOne(panel, false);
            }
        }

        function tick() {
            const ui = document.getElementById('tiktok-repost-ui');
            const icon = document.getElementById('tiktok-minimized-icon');

            const v = findBestFeedVideo(false);
            if (v && !v.paused) {
                attachToVideo(v);
            } else if (v && v.paused && lastVideo === v) {
                beatPeak *= 0.9;
            }

            const nowMs = performance.now();
            let didAudioSample = false;
            if (analyser && audioCtx) {
                if (nowMs - lastSampleAt >= AUDIO_SAMPLE_INTERVAL_MS) {
                    lastSampleAt = nowMs;
                    didAudioSample = true;
                    const d = computeBeatDrive();
                    if (!timeWaveBuf || timeWaveBuf.length !== analyser.fftSize) {
                        timeWaveBuf = new Uint8Array(analyser.fftSize);
                    }
                    analyser.getByteTimeDomainData(timeWaveBuf);
                    lastDriveSample = d;
                }
            } else {
                lastDriveSample *= 0.88;
                if (lastDriveSample < 0.02) lastDriveSample = 0;
                didAudioSample = true;
            }

            const drive = lastDriveSample;

            const targetPulse = 1 + Math.min(drive * 0.26, 0.24);
            const up = targetPulse > displaySmooth ? 0.62 : 0.20;
            displaySmooth += (targetPulse - displaySmooth) * up;

            const bright = 0.90 + Math.min(drive * 0.55, 0.18);
            const glow = 5 + drive * 52;
            const pulseKey = `${bright.toFixed(2)}|${glow.toFixed(1)}`;
            if (pulseKey !== lastPulseFilterKey) {
                lastPulseFilterKey = pulseKey;
                const apply = (el) => {
                    if (!el || el.style.display === 'none') return;
                    el.style.filter = `brightness(${bright.toFixed(3)}) drop-shadow(0 0 ${glow.toFixed(1)}px rgba(254,44,85,0.58))`;
                };

                if (ui && ui.style.display !== 'none') apply(ui);
                if (icon && icon.style.display !== 'none') apply(icon);
            }

            if (didAudioSample) {
                paintMusicWaves(analyser && timeWaveBuf ? timeWaveBuf : null,
                    freqBuf,
                    !!analyser,
                    Math.min(1, drive));
            }

            requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }

    function getUserInfo() {
        const FALLBACK = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjI0KSI+PGNpcmNsZSBjeD0iMTIiIGN5PSI4IiByPSI0Ii8+PHBhdGggZD0iTTEyLDE0Yy02LjEsMC0xMiw0LTEyLDR2MmgyNHYtMkMyNCwxOCwxOC4xLDE0LDEyLDE0eiIvPjwvc3ZnPg==';
        const navAvatar = document.querySelector('[data-e2e="profile-icon"] img') ||
            document.querySelector('a[href*="/@"] img[src*="tiktokcdn"]');
        const editBtn = document.querySelector('[data-e2e="edit-profile-entrance"]') ||
            document.querySelector('button[class*="Edit"]');
        const pageKind = getPageKind();
        const cached = getCachedUserProfile();
        const hasProfileCache = !!cached;

        const sel = {
            nickname: '[data-e2e="user-title"], h1[class*="Nickname"]',
            username: '[data-e2e="user-subtitle"], h2[class*="UniqueId"]',
            stats: '[data-e2e$="-count"], [class*="StrongStatCount"]'
        };

        const loggedIn = !!(navAvatar && navAvatar.src && navAvatar.src.startsWith('http')) || !!editBtn;

        if (pageKind === 'own') {
            const profileAvatar = document.querySelector('[data-e2e="user-avatar"] img') ||
                document.querySelector('img[class*="Avatar"]');
            const nickEl = document.querySelector(sel.nickname);
            const userEl = document.querySelector(sel.username);
            const stats = Array.from(document.querySelectorAll(sel.stats)).map(el => el.innerText);
            const info = {
                loggedIn: true,
                pageKind: 'own',
                hasProfileCache,
                needsProfileSync: false,
                isOwnProfile: true,
                canBulkActions: true,
                avatar: (profileAvatar && profileAvatar.src && profileAvatar.src.startsWith('http')) ? profileAvatar.src : ((navAvatar && navAvatar.src) || FALLBACK),
                nickname: nickEl ? nickEl.innerText.trim() : 'Người dùng TikTok',
                username: userEl ? userEl.innerText.trim() : '@unknown',
                following: stats[0] || '0',
                followers: stats[1] || '0',
                likes: stats[2] || '0'
            };
            if (!localStorage.getItem(TRU_CACHE_KEY)) {
                localStorage.setItem(TRU_CACHE_KEY, JSON.stringify(info));
            }
            return info;
        }

        if (pageKind === 'other') {
            const profileAvatar = document.querySelector('[data-e2e="user-avatar"] img') ||
                document.querySelector('img[class*="Avatar"]');
            const nickEl = document.querySelector(sel.nickname);
            const userEl = document.querySelector(sel.username);
            const stats = Array.from(document.querySelectorAll(sel.stats)).map(el => el.innerText);
            return {
                loggedIn: !!(profileAvatar || nickEl || navAvatar || editBtn),
                pageKind: 'other',
                hasProfileCache,
                needsProfileSync: false,
                isOwnProfile: false,
                canBulkActions: false,
                avatar: (profileAvatar && profileAvatar.src && profileAvatar.src.startsWith('http')) ? profileAvatar.src : FALLBACK,
                nickname: nickEl ? nickEl.innerText.trim() : 'Người dùng TikTok',
                username: userEl ? userEl.innerText.trim() : '@unknown',
                following: stats[0] || '—',
                followers: stats[1] || '—',
                likes: stats[2] || '—'
            };
        }

        const fallbackNick = cached?.nickname || '—';
        const fallbackUser = cached?.username || '@—';
        const needsProfileSync = loggedIn && !hasProfileCache;
        return {
            loggedIn,
            pageKind: 'feed',
            hasProfileCache,
            needsProfileSync,
            isOwnProfile: false,
            canBulkActions: loggedIn && hasProfileCache,
            avatar: (cached?.avatar && String(cached.avatar).startsWith('http')) ? cached.avatar
                : ((navAvatar && navAvatar.src && navAvatar.src.startsWith('http')) ? navAvatar.src : FALLBACK),
            nickname: hasProfileCache ? fallbackNick : (loggedIn ? 'Chưa đồng bộ hồ sơ' : '—'),
            username: hasProfileCache ? fallbackUser : (loggedIn ? 'Vào trang của bạn 1 lần' : '—'),
            following: hasProfileCache ? (cached.following || '—') : '—',
            followers: hasProfileCache ? (cached.followers || '—') : '—',
            likes: hasProfileCache ? (cached.likes || '—') : '—'
        };
    }

    async function signF(url) {
        const c = window.my_acrawler || window.byted_acrawler || window._mssdk;
        let f = url; if (c && c.sign) { try { f = c.sign({ url: url }); } catch (e) { try { f = c.sign(url); } catch (e2) { } } }
        const csrf = document.cookie.split('; ').find(r => r.startsWith('tt-csrf-token='))?.split('=')[1] || '';
        try { return await (await originalFetch(f, { method: 'POST', credentials: 'include', headers: { 'tt-csrf-token': csrf, 'x-requested-with': 'XMLHttpRequest' } })).json(); } catch (e) { return null; }
    }

    window.deleteTiktokRepost = async (id, el) => {
        if (!window.tiktokLastUrlObj) return false;
        if (el) { el.innerText = "⏳"; el.disabled = true; }
        const u = new URL(window.tiktokLastUrlObj.href); u.pathname = '/tiktok/v1/upvote/delete'; u.searchParams.set('item_id', id);
        ['X-Bogus', '_signature', 'X-Gnarly'].forEach(p => u.searchParams.delete(p));
        const d = await signF(u.href);
        if (d && d.status_code === 0) { if (el) { el.innerText = "✅"; el.style.background = "rgba(40,167,69,0.2)"; } return true; }
        if (el) { el.innerText = "❌"; el.disabled = false; } return false;
    };

    window.unfavoriteTiktokVideo = (id, el) => { if (el) el.innerText = "⏳"; window.open(`https://www.tiktok.com/@user/video/${id}?autounfav=1`, '_blank'); return true; };

    function clampDelaySec(v, loS, hiS) {
        if (v === '' || v == null) return null;
        const n = parseFloat(String(v).trim().replace(',', '.'));
        if (!Number.isFinite(n)) return null;
        return Math.min(hiS, Math.max(loS, n));
    }

    function formatDelaySec(sec) {
        if (!Number.isFinite(sec)) return '1.2';
        return (Math.round(sec * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
    }

    function msToDisplayedSec(ms) {
        const s = (Number(ms) || 1200) / 1000;
        return Math.round(s * 1000) / 1000;
    }

    /** Parse giây từ input UI → ms (clamp theo hi ms). */
    function parseSecStrToMs(v, loMs, hiMs) {
        const sec = clampDelaySec(v, loMs / 1000, hiMs / 1000);
        return sec != null ? Math.round(sec * 1000) : null;
    }

    function getProcessingDelayMs() {
        const slider = document.getElementById('delay-range');
        const num = document.getElementById('delay-general-num');
        let v = parseSecStrToMs(num && num.value !== '' ? num.value : null, 200, 60000);
        if (v == null && slider) v = parseSecStrToMs(slider.value, 200, 60000);
        return v != null ? v : 1200;
    }

    function getFollowingUnfollowDelayMs() {
        const ck = document.getElementById('delay-fl-random');
        if (ck && ck.checked) {
            const minEl = document.getElementById('delay-fl-min');
            const maxEl = document.getElementById('delay-fl-max');
            let lo = parseSecStrToMs(minEl?.value, 200, 30000) ?? 800;
            let hi = parseSecStrToMs(maxEl?.value, 200, 30000) ?? 2500;
            if (hi < lo) { const t = lo; lo = hi; hi = t; }
            return Math.floor(lo + Math.random() * (hi - lo + 1));
        }
        const slider = document.getElementById('delay-range-fl');
        const num = document.getElementById('delay-fl-num');
        let v = parseSecStrToMs(num && num.value !== '' ? num.value : null, 300, 30000);
        if (v == null && slider) v = parseSecStrToMs(slider.value, 300, 30000);
        if (v == null) {
            const fallback = document.getElementById('delay-range');
            v = parseSecStrToMs(fallback?.value, 300, 30000) ?? 1200;
        }
        return v;
    }

    function isBannedFriendFollowButton(btn) {
        const t = (btn.innerText || '').trim();
        const aria = (btn.getAttribute('aria-label') || '');
        return /Bạn bè/i.test(t) || /Bạn bè/i.test(aria);
    }

    function isDaFollowUnfollowDomButton(btn) {
        if (!btn || btn.getAttribute('data-e2e') !== 'follow-button') return false;
        if (isBannedFriendFollowButton(btn)) return false;
        const t = (btn.innerText || '').trim();
        const aria = (btn.getAttribute('aria-label') || '');
        if (/đã\s*follow/i.test(t) || /đã\s*follow/i.test(aria)) return true;
        if (t === 'Following' || /\bFollowing\b/i.test(aria)) return true;
        return false;
    }

    function findDaFollowButtonForUniqueId(uniqueIdRaw) {
        const uid = (uniqueIdRaw || '').replace(/^@/, '').trim().toLowerCase();
        if (!uid) return null;
        for (const btn of document.querySelectorAll('button[data-e2e="follow-button"]')) {
            if (!isDaFollowUnfollowDomButton(btn)) continue;
            let p = btn;
            for (let i = 0; i < 16 && p; i++) {
                const low = (p.textContent || '').toLowerCase();
                if (low.includes('@' + uid)) return btn;
                p = p.parentElement;
            }
        }
        return null;
    }

    async function unfollowTiktokUserDom(uniqueId, el) {
        const btn = findDaFollowButtonForUniqueId(uniqueId);
        if (!btn) {
            if (el) { el.innerText = "❌"; el.disabled = false; }
            return false;
        }
        if (el) { el.innerText = "⏳"; el.disabled = true; }
        btn.click();
        await new Promise(r => setTimeout(r, getFollowingUnfollowDelayMs()));
        if (el) { el.innerText = "✅"; el.style.background = "rgba(40,167,69,0.2)"; }
        return true;
    }

    window.unfollowTiktokUserDom = unfollowTiktokUserDom;

    async function bulkUnfollowDomLoop(statusEl) {
        const maxLoops = 50000;
        let n = 0;
        for (let i = 0; i < maxLoops; i++) {
            const candidates = findDaFollowButtonsInFollowingModal();
            const next = candidates[0];
            if (!next) break;
            n++;
            const delay = getFollowingUnfollowDelayMs();
            const line = `⏳ HUỶ ${n} (delay ~${ formatDelaySec((delay || 0) / 1000) }s)`;
            if (statusEl) statusEl.innerText = line;
            updateFlBulkUI(`④ Đang hủy follow…`, n);
            try {
                next.scrollIntoView({ block: 'center', behavior: 'auto' });
            } catch (e) { next.scrollIntoView(true); }
            await new Promise(r => setTimeout(r, 420));
            next.click();
            await new Promise(r => setTimeout(r, delay));
        }
        return n;
    }

    window.bulkUnfollowDomLoop = bulkUnfollowDomLoop;

    window.tiktokLastFollowingUrlObj = null;

    function dedupeFollowingPush(arr) {
        const seen = new Set(window.allFollowing.map(entry => {
            const usr = entry.user || entry;
            return usr.secUid || usr.sec_uid || usr.id || '';
        }).filter(Boolean));
        arr.forEach(entry => {
            const usr = entry.user || entry;
            const id = usr.secUid || usr.sec_uid || usr.id;
            if (id && !seen.has(id)) { seen.add(id); window.allFollowing.push(entry); }
        });
    }

    function safeUnfBtnId(sec) { return 'btn-unf-' + String(sec).replace(/\W/g, '_'); }

    function openFollowingStatsClick() {
        const byE2e = document.querySelector('[data-e2e="following-count"]');
        const target = (byE2e && (byE2e.closest('a[href]') || byE2e.closest('[role="button"]') || byE2e.closest('div[class*="DivNumber"]'))) || byE2e;
        if (target) target.click();
    }

    function findDaFollowButtonsInFollowingModal() {
        const sc = findTiktokFollowingListScrollRoot();
        if (!sc) return [];
        let list = Array.from(sc.querySelectorAll('button[data-e2e="follow-button"]')).filter(isDaFollowUnfollowDomButton);
        if (list.length) return list;
        const dialog = sc.closest('[role="dialog"]') || sc.closest('[aria-modal="true"]') || sc.closest('div[class*="Modal"]');
        if (dialog) {
            list = Array.from(dialog.querySelectorAll('button[data-e2e="follow-button"]')).filter(isDaFollowUnfollowDomButton);
            if (list.length) return list;
        }
        let p = sc.parentElement;
        for (let d = 0; d < 14 && p; d++, p = p.parentElement) {
            list = Array.from(p.querySelectorAll('button[data-e2e="follow-button"]')).filter(isDaFollowUnfollowDomButton);
            if (list.length) return list;
        }
        return [];
    }

    function updateFlBulkUI(phaseLabel, unfollowCount) {
        const p = document.getElementById('fl-bulk-phase');
        const c = document.getElementById('fl-bulk-unfollow-count');
        if (p != null && phaseLabel != null && phaseLabel !== '') p.textContent = phaseLabel;
        if (arguments.length >= 2 && c != null && typeof unfollowCount === 'number' && Number.isFinite(unfollowCount))
            c.textContent = String(unfollowCount);
    }

    function findTiktokFollowingListScrollRoot() {
        function visible(el) {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return false;
            const st = getComputedStyle(el);
            return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || '1') > 0.05;
        }
        const nodes = document.querySelectorAll('[class*="DivUserListContainer"], [class*="UserListContainer"]');
        let best = null;
        let bestArea = 0;
        for (const el of nodes) {
            if (!visible(el)) continue;
            if (el.scrollHeight > el.clientHeight + 2) return el;
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; best = el; }
        }
        return best;
    }

    async function waitForFollowingModalRoot(timeoutMs) {
        const tick = 280;
        for (let elapsed = 0; elapsed <= timeoutMs; elapsed += tick) {
            if (findTiktokFollowingListScrollRoot()) return true;
            await new Promise(r => setTimeout(r, tick));
        }
        return false;
    }

    async function autoScrollFollowingListToEnd(statusEl, opts) {
        const pauseMsMin = 2200;
        const pauseMsJitter = 900;
        const maxRounds = 600;
        const needStable = 9;
        let stable = 0;
        let lastH = 0;
        for (let i = 0; i < maxRounds; i++) {
            const sc = findTiktokFollowingListScrollRoot();
            if (!sc) {
                if (statusEl) statusEl.innerText = '⚠️ Mở popup Đang follow trước';
                return false;
            }
            const hBefore = sc.scrollHeight;
            sc.scrollTop = sc.scrollHeight;
            const waitMs = pauseMsMin + Math.floor(Math.random() * (pauseMsJitter + 1));
            if (statusEl) {
                statusEl.innerText = `⏳ Cuộn tải list… ${hBefore}px (~${Math.round(waitMs / 1000)}s/lần)`;
                updateFlBulkUI(`② Cuộn tải · ${hBefore}px · ~${Math.round(waitMs / 1000)}s/lần [chưa hủy FL]`);
            }
            await new Promise(r => setTimeout(r, waitMs));
            const sc2 = findTiktokFollowingListScrollRoot();
            const hAfter = sc2 ? sc2.scrollHeight : hBefore;
            lastH = hAfter || hBefore;
            const atBottom = sc2 ? (sc2.scrollTop + sc2.clientHeight >= hAfter - 6) : true;
            if (hAfter <= hBefore && atBottom) {
                stable++;
                if (stable >= needStable) break;
            } else {
                stable = 0;
            }
        }
        if (statusEl && !(opts && opts.suppressFinalDone)) statusEl.innerText = `✅ Đã cuộn xong (~${lastH}px)`;
        return true;
    }

    /** Chờ lazy-load dừng: cuộn xuống đáy nhiều lần, chiều cao không đổi liên tiếp. Chỉ gọi sau bước cuộn chính. */
    async function waitFollowingListScrollSettled(btnOrLabel, stablePasses, gapMs) {
        const passes = stablePasses != null ? stablePasses : 5;
        const gap = gapMs != null ? gapMs : 1200;
        let stable = 0;
        let lastH = -1;
        for (let i = 0; i < 96 && stable < passes; i++) {
            const sc = findTiktokFollowingListScrollRoot();
            if (!sc) {
                const msg = '⚠️ Mất khung danh sách — mở lại popup';
                if (btnOrLabel && btnOrLabel.innerText != null) btnOrLabel.innerText = msg;
                updateFlBulkUI(msg);
                return false;
            }
            sc.scrollTop = sc.scrollHeight;
            await new Promise(r => setTimeout(r, gap));
            const h = sc.scrollHeight;
            if (lastH >= 0 && Math.abs(h - lastH) <= 4) stable++;
            else stable = 0;
            lastH = h;
            const line = `⏳ Đợi tải xong (${stable}/${passes}) · ${h}px`;
            if (btnOrLabel && btnOrLabel.innerText != null) btnOrLabel.innerText = line;
            updateFlBulkUI(line);
        }
        await new Promise(r => setTimeout(r, 900));
        if (stable < passes) {
            const msg = '⚠️ Danh sách vẫn tải sau lâu — đóng popup, mở lại rồi thử';
            if (btnOrLabel && btnOrLabel.innerText != null) btnOrLabel.innerText = msg;
            updateFlBulkUI(msg);
            return false;
        }
        return true;
    }

    window.autoScrollFollowingListToEnd = autoScrollFollowingListToEnd;

    async function runFlFullUnfollowFlow(btn) {
        if (window._tiktokFlBulkRunning) return;
        window._tiktokFlBulkRunning = true;
        const prev = btn.innerText;
        btn.disabled = true;
        updateFlBulkUI('Sẵn sàng…', 0);
        try {
            btn.innerText = '⏳ ① Mở popup…';
            updateFlBulkUI('① Đang mở popup Đang follow…', 0);
            openFollowingStatsClick();
            const ready = await waitForFollowingModalRoot(18000);
            if (!ready) {
                btn.innerText = '⚠️ Không thấy popup Đang follow';
                updateFlBulkUI(btn.innerText, 0);
                await new Promise(r => setTimeout(r, 2800));
                return;
            }
            btn.innerText = '⏳ ② Cuộn tải (chưa hủy)…';
            updateFlBulkUI('② Đang cuộn để load toàn bộ danh sách…', 0);
            const scrolled = await autoScrollFollowingListToEnd(btn, { suppressFinalDone: true });
            if (!scrolled) {
                btn.innerText = '⚠️ Mất khung danh sách — mở lại popup';
                updateFlBulkUI(btn.innerText, 0);
                await new Promise(r => setTimeout(r, 2800));
                return;
            }
            btn.innerText = '⏳ ③ Chờ list ổn định…';
            const settled = await waitFollowingListScrollSettled(btn, 5, 1200);
            if (!settled) {
                btn.innerText = '⚠️ Không chờ được list ổn định';
                updateFlBulkUI(btn.innerText, 0);
                await new Promise(r => setTimeout(r, 2800));
                return;
            }
            btn.innerText = '⏳ ④ Hủy follow…';
            updateFlBulkUI('④ Đang hủy follow (đã cuộn xong)…', 0);
            const n = await bulkUnfollowDomLoop(btn);
            window.allFollowing = [];
            const fl = document.getElementById('following-list');
            if (fl) fl.innerHTML = '';
            btn.innerText = n ? `✅ ĐÃ HUỶ ${n}` : '⚠️ Không thấy nút Đã follow';
            updateFlBulkUI(btn.innerText, n);
            await new Promise(r => setTimeout(r, 2200));
        } finally {
            btn.innerText = prev;
            btn.disabled = false;
            window._tiktokFlBulkRunning = false;
            updateFlBulkUI('Sẵn sàng');
        }
    }

    function switchT(t) {
        const tabs = ['repost', 'fav', 'like', 'dl', 'follow', 'settings'];
        const index = tabs.indexOf(t);
        const indicator = document.querySelector('.nav-indicator');
        if (indicator) {
            indicator.style.transform = `translateX(${index * 100}%)`;
        }
        tabs.forEach(tab => {
            const p = document.getElementById('panel-' + tab); const b = document.getElementById('tab-' + tab);
            if (p) p.style.display = (tab === t ? 'flex' : 'none');
            if (b) b.classList.toggle('active', tab === t);
        });
    }

    // --- GUI ---
    function createUI() {
        if (document.getElementById('tiktok-repost-ui')) return;
        const info = getUserInfo();
        const style = document.createElement('style');
        style.textContent = `
            :root {
                --pk-red: #FE2C55; --pk-cyan: #25F4EE;
                --pk-bg: rgba(12, 13, 18, 0.94);
                --pk-surface: rgba(255,255,255,0.045);
                --pk-line: rgba(255,255,255,0.08);
                --pk-radius: 16px;
                --pk-font: system-ui, -apple-system, "Segoe UI", Inter, Outfit, sans-serif;
            }
            #tiktok-repost-ui {
                position: fixed; top: 20px; right: 16px;
                width: min(310px, calc(100vw - 24px));
                height: min(592px, calc(100vh - 32px));
                z-index: 2147483647; display: flex; flex-direction: column;
                font-family: var(--pk-font); font-size: 11px; color: #f1f3f5;
                background: linear-gradient(165deg, rgba(22,22,30,0.98) 0%, var(--pk-bg) 42%);
                backdrop-filter: blur(40px) saturate(150%);
                -webkit-backdrop-filter: blur(40px) saturate(150%);
                border: 1px solid var(--pk-line);
                border-radius: var(--pk-radius);
                box-shadow: 0 20px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset;
                overflow: hidden; user-select: none;
                animation: widgetIn 0.38s cubic-bezier(0.22, 1, 0.36, 1);
            }
            @keyframes widgetIn { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: none; } }
            .ui-win { position: absolute; top: 8px; right: 10px; display: flex; gap: 4px; z-index: 12; }
            .ui-win__btn {
                width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                font-size: 15px; line-height: 1; color: rgba(255,255,255,0.45);
                background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06);
                transition: color 0.15s, background 0.15s;
            }
            .ui-win__btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
            .header-orb {
                flex-shrink: 0; position: relative;
                padding: 12px 12px 8px;
                background: radial-gradient(100% 90% at 100% 0%, rgba(254,44,85,0.11), transparent 55%);
            }
            .header-orb__row { display: flex; gap: 10px; align-items: center; padding: 22px 4px 2px; min-width: 0; }
            .avatar-ring {
                flex-shrink: 0; position: relative;
                width: 44px; height: 44px; padding: 2px; border-radius: 14px;
                background: linear-gradient(140deg, var(--pk-red), var(--pk-cyan));
                box-shadow: 0 0 0 1px rgba(0,0,0,0.35), 0 4px 14px rgba(254,44,85,0.15);
            }
            .avatar-img { width: 100%; height: 100%; border-radius: 12px; object-fit: cover; background: #111; display: block; }
            .ui-identity { min-width: 0; flex: 1; }
            .ui-nick { font-size: 15px; font-weight: 800; letter-spacing: -0.3px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ui-handle { font-size: 11px; font-weight: 700; color: var(--pk-cyan); opacity: 0.85; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ui-badge {
                position: absolute; bottom: -2px; right: -2px;
                font-size: 6px; font-weight: 900; padding: 2px 4px; border-radius: 5px;
                border: 1px solid rgba(0,0,0,0.5); line-height: 1;
            }
            .stat-grid {
                display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
                margin: 0 10px 8px; padding: 0 2px;
            }
            .stat-box {
                background: var(--pk-surface); padding: 7px 4px; border-radius: 11px;
                border: 1px solid rgba(255,255,255,0.05); text-align: center;
                transition: background 0.2s, border-color 0.2s;
            }
            .stat-box:hover { background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.1); }
            .stat-val { font-size: 14px; font-weight: 800; display: block; letter-spacing: -0.3px; }
            .stat-lab { font-size: 7px; font-weight: 800; opacity: 0.38; text-transform: uppercase; margin-top: 2px; letter-spacing: 0.4px; }
            .nav-bar {
                display: flex; position: relative;
                margin: 0 10px 6px; padding: 4px;
                background: rgba(0,0,0,0.22); border-radius: 12px;
                border: 1px solid rgba(255,255,255,0.06);
            }
            .nav-item {
                flex: 1; padding: 7px 0; text-align: center; cursor: pointer; z-index: 2;
                display: flex; flex-direction: column; align-items: center; gap: 1px;
                transition: transform 0.15s;
            }
            .nav-icon { font-size: 14px; opacity: 0.38; transition: opacity 0.2s, transform 0.2s; line-height: 1; }
            .nav-text { font-size: 7px; font-weight: 800; opacity: 0.32; text-transform: uppercase; letter-spacing: 0.35px; }
            .nav-item.active .nav-icon { opacity: 1; transform: scale(1.06); }
            .nav-item.active .nav-text { opacity: 0.9; color: var(--pk-red); }
            .nav-indicator {
                position: absolute; top: 4px; bottom: 4px; left: 4px;
                width: calc(16.666666% - 2.666px); border-radius: 9px;
                background: linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.04));
                border: 1px solid rgba(255,255,255,0.06);
                transition: transform 0.38s cubic-bezier(0.18, 0.89, 0.32, 1.25);
                z-index: 1;
            }
            #panel-container { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; padding: 8px 10px 10px; gap: 0; }
            .pk-card {
                background: var(--pk-surface); border: 1px solid var(--pk-line);
                border-radius: 12px; padding: 10px 11px;
            }
            .pk-hint { font-size: 9px; opacity: 0.42; line-height: 1.45; margin: 6px 0 0; }
            .pk-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
            .pk-label { font-size: 9px; font-weight: 800; opacity: 0.48; letter-spacing: 0.4px; text-transform: uppercase; }
            .pk-val { font-size: 12px; font-weight: 800; color: var(--pk-cyan); }
            .pk-input {
                width: 62px; background: rgba(0,0,0,0.38); border: 1px solid rgba(255,255,255,0.1);
                color: #fff; border-radius: 8px; padding: 5px 6px; font-size: 11px; font-weight: 800; text-align: center;
            }
            .pk-input--wide { width: 68px; }
            .pk-check { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 9px; font-weight: 700; opacity: 0.88; cursor: pointer; }
            .main-action {
                border: none; color: #fff; padding: 10px 12px; border-radius: 11px;
                font-weight: 800; font-size: 11px; cursor: pointer; width: 100%;
                background: linear-gradient(135deg, var(--pk-red), #e91e5a);
                box-shadow: 0 8px 22px rgba(254,44,85,0.28);
                transition: transform 0.15s, box-shadow 0.15s, filter 0.15s;
                letter-spacing: 0.2px; line-height: 1.3;
            }
            .main-action:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 12px 28px rgba(254,44,85,0.38); filter: brightness(1.04); }
            .main-action:disabled { opacity: 0.32; cursor: not-allowed; transform: none !important; filter: none; }
            .main-action--fl {
                background: linear-gradient(125deg, var(--pk-cyan), #6c5ce7 50%, var(--pk-red));
                box-shadow: 0 8px 24px rgba(37,244,238,0.18);
            }
            .main-action--fl:hover:not(:disabled) { box-shadow: 0 12px 30px rgba(37,244,238,0.25); }
            .list-scroll { overflow-y: auto; margin-top: 8px; flex: 1; min-height: 0; }
            .item-glass {
                background: rgba(255,255,255,0.025); border-radius: 11px;
                padding: 9px 11px; margin-bottom: 7px;
                display: flex; justify-content: space-between; align-items: center; gap: 10px;
                border: 1px solid rgba(255,255,255,0.06); transition: background 0.15s, border-color 0.15s;
            }
            .item-glass:hover { background: rgba(255,255,255,0.055); border-color: rgba(255,255,255,0.12); }
            .video-desc {
                font-size: 10px; opacity: 0.58; line-height: 1.35;
                display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                overflow: hidden; word-break: break-word;
            }
            .ui-foot {
                flex-shrink: 0; padding: 8px 10px;
                display: flex; justify-content: space-between; align-items: center; gap: 8px;
                background: rgba(0,0,0,0.25); border-top: 1px solid rgba(255,255,255,0.06);
            }
            .ui-foot__meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
            .ui-foot__img { width: 32px; height: 32px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); object-fit: cover; flex-shrink: 0; }
            .ui-foot__name { font-size: 11px; font-weight: 800; opacity: 0.92; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ui-foot__ver { font-size: 7px; opacity: 0.38; font-weight: 800; letter-spacing: 0.5px; color: var(--pk-cyan); margin-top: 1px; }
            .ui-foot__links { display: flex; gap: 5px; flex-shrink: 0; }
            .ui-foot__a {
                text-decoration: none; font-size: 9px; font-weight: 800; color: rgba(255,255,255,0.45);
                background: rgba(255,255,255,0.06); padding: 4px 7px; border-radius: 7px;
                border: 1px solid rgba(255,255,255,0.06);
            }
            .ui-foot__a:hover { color: #fff; background: rgba(255,255,255,0.1); }
            #panel-settings { gap: 8px !important; }
            ::-webkit-scrollbar { width: 0; height: 0; }
            #tiktok-minimized-icon {
                position: fixed; bottom: 40px; right: 40px; width: 50px; height: 50px;
                z-index: 2147483647; cursor: pointer; display: none;
                align-items: center; justify-content: center;
                border-radius: 18px; background: var(--pk-bg); backdrop-filter: blur(20px);
                border: 2px solid var(--pk-red); box-shadow: 0 15px 40px rgba(0,0,0,0.6);
                transition: transform 0.25s ease, box-shadow 0.25s ease;
                overflow: visible; box-sizing: border-box;
            }
            #tiktok-minimized-icon .tiktok-mini-wave {
                position: absolute;
                left: 50%; top: 50%;
                width: 50px; height: 50px;
                margin-left: -25px; margin-top: -25px;
                border-radius: 18px;
                border: 2px solid rgba(254, 44, 85, 0.5);
                pointer-events: none;
                z-index: 0;
                animation: miniSoundWave 2.4s ease-out infinite;
                box-sizing: border-box;
            }
            #tiktok-minimized-icon .tiktok-mini-wave--2 {
                border-color: rgba(37, 244, 238, 0.45);
                animation-delay: 0.6s;
            }
            #tiktok-minimized-icon .tiktok-mini-wave--3 {
                border-color: rgba(254, 44, 85, 0.35);
                animation-delay: 1.2s;
            }
            #tiktok-minimized-icon .tiktok-mini-avatar {
                width: 100%; height: 100%; object-fit: cover; object-position: center;
                display: block; pointer-events: none; border-radius: 16px;
                position: relative; z-index: 1;
            }
            #tiktok-minimized-icon #tru-mini-wave-canvas {
                position: absolute; left: 0; right: 0; bottom: 0;
                width: 100%; height: 22px; z-index: 2; pointer-events: none;
                border-radius: 0 0 14px 14px; display: block;
            }
            #tru-panel-wave-wrap {
                width: 100%; padding: 0 10px 2px; margin: 0 0 6px; box-sizing: border-box;
            }
            #tru-panel-wave-canvas {
                display: block; width: 100%; height: 38px;
                border-radius: 10px; background: rgba(0,0,0,0.2);
            }
            #tiktok-minimized-icon:hover { transform: scale(1.05); }
            @keyframes miniSoundWave {
                0% { transform: scale(1); opacity: 0.7; }
                100% { transform: scale(2.85); opacity: 0; }
            }
        `;
        if (!document.getElementById('tru-inject-style')) {
            style.id = 'tru-inject-style';
            document.head.appendChild(style);
        }
        const ui = document.createElement('div'); ui.id = 'tiktok-repost-ui'; ui.className = 'ghost-overlay';
        const _v = { k: '4e677579656e2056616e204b69656e', f: '68747470733a2f2f7765622e66616365626f6f6b2e636f6d2f766e6b696e2e3036', i: '68747470733a2f2f7777772e696e7374616772616d2e636f6m2f5f766e6b696e2e30392f', p: '68747470733a2f2f692e6962622e636f2f4335356339706b622f3636393331393839342d3132323237393330353435343332303836332d343639313832303837373339373035313337392d6e2e6a7067' };
        const h2s = (h) => h.match(/.{1,2}/g).map(c => String.fromCharCode(parseInt(c, 16))).join('');
        // We use the direct link for now, but in case of CSP, we fallback to the local one or a very small version.
        // I will use the Facebook link as primary fallback since it's more stable for CSP usually.
        const dImg = "data:image/jpeg;base64,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";

        const defUser = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjI0KSI+PGNpcmNsZSBjeD0iMTIiIGN5PSI4IiByPSI0Ii8+PHBhdGggZD0iTTEyLDE0Yy02LjEsMC0xMiw0LTEyLDR2MmgyNHYtMkMyNCwxOCwxOC4xLDE0LDEyLDE0eiIvPjwvc3ZnPg==';
        ui.innerHTML = `
            <div class="header-orb" id="ui-header" style="cursor:move;">
                <div class="ui-win">
                    <div id="minimize-ui" class="ui-win__btn" title="Thu gọn">−</div>
                    <div class="ui-win__btn" title="Đóng" onclick="this.closest('#tiktok-repost-ui').remove()">✕</div>
                </div>
                <div class="header-orb__row">
                    <div class="avatar-ring">
                        <img id="ui-user-avatar" src="${info.avatar || defUser}" onerror="this.src='${defUser}'" class="avatar-img" alt="">
                        <div id="ui-profile-status" class="ui-badge" style="background:#25F4EE;color:#000;">VERIFIED</div>
                    </div>
                    <div class="ui-identity">
                        <div id="ui-user-nickname" class="ui-nick">${info.nickname}</div>
                        <div id="ui-user-username" class="ui-handle">${info.username}</div>
                    </div>
                </div>
            </div>
            <div class="stat-grid">
                <div class="stat-box"><span class="stat-val">${info.following}</span><span class="stat-lab">Đang FL</span></div>
                <div class="stat-box"><span class="stat-val">${info.followers}</span><span class="stat-lab">Follower</span></div>
                <div class="stat-box"><span class="stat-val">${info.likes}</span><span class="stat-lab">Thích</span></div>
            </div>
            <div class="tru-panel-wave-wrap" id="tru-panel-wave-wrap" style="display:none;">
                <canvas id="tru-panel-wave-canvas" aria-hidden="true"></canvas>
            </div>
            <div class="nav-bar">
                <div class="nav-indicator"></div>
                <div class="nav-item active" id="tab-repost"><span class="nav-icon">🔄</span><span class="nav-text">RP</span></div>
                <div class="nav-item" id="tab-fav"><span class="nav-icon">⭐</span><span class="nav-text">Fav</span></div>
                <div class="nav-item" id="tab-like"><span class="nav-icon">❤️</span><span class="nav-text">Like</span></div>
                <div class="nav-item" id="tab-dl"><span class="nav-icon">⬇️</span><span class="nav-text">Tải</span></div>
                <div class="nav-item" id="tab-follow"><span class="nav-icon">👥</span><span class="nav-text">FL</span></div>
                <div class="nav-item" id="tab-settings"><span class="nav-icon">⚙️</span><span class="nav-text">Set</span></div>
            </div>
            <div id="panel-container">
                <div id="panel-repost" style="display:flex;flex-direction:column;height:100%;">
                    <button id="del-all-btn" class="main-action">Xóa hết Repost</button>
                    <div id="repost-list" class="list-scroll"></div>
                </div>
                <div id="panel-fav" style="display:none;flex-direction:column;height:100%;">
                    <button id="unfav-all-btn" class="main-action">Gỡ hết video yêu thích</button>
                    <div id="fav-list" class="list-scroll"></div>
                </div>
                <div id="panel-like" style="display:none;flex-direction:column;height:100%;">
                    <button class="main-action" style="opacity:0.28;" disabled>Chưa hỗ trợ Like hàng loạt</button>
                </div>
                <div id="panel-dl" style="display:none;flex-direction:column;height:100%;gap:8px;overflow-y:auto;">
                    <div class="pk-card" id="tru-viewer-card">
                        <div class="pk-label">Clip / ảnh đang xem</div>
                        <div id="tru-viewer-id" style="font-size:10px;opacity:0.55;line-height:1.35;margin-top:4px;">—</div>
                        <div id="tru-cache-count" style="font-size:9px;opacity:0.42;margin-top:5px;line-height:1.35;">—</div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:11px;font-weight:800;">
                            <div>❤️ <span id="tru-stat-digg">—</span></div>
                            <div>💬 <span id="tru-stat-comment">—</span></div>
                            <div>↗️ <span id="tru-stat-share">—</span></div>
                            <div>▶️ <span id="tru-stat-play">—</span></div>
                        </div>
                    </div>
                    <button id="tru-btn-dl-video" type="button" class="main-action">Tải video (ưu tiên API / không logo khi TikTok cho)</button>
                    <button id="tru-btn-dl-photos" type="button" class="main-action" style="display:none;background:linear-gradient(135deg,#25F4EE,#6c5ce7);">Tải ảnh (carousel / DOM)</button>
                    <p class="pk-hint" style="opacity:0.5;line-height:1.4;">Ảnh: ưu tiên JSON item_list; không có thì gom <code style="font-size:9px;">img</code> lớn trên trang (/photo/ hoặc bài ảnh). TikTok có thể gắn watermark.</p>
                    <p id="tru-dl-status" class="pk-hint" style="margin-top:0;min-height:14px;"></p>
                </div>
                <div id="panel-follow" style="display:none;flex-direction:column;height:100%;">
                    <button id="btn-fl-full-flow" class="main-action main-action--fl">Hủy follow hàng loạt · mở popup → cuộn → hủy</button>
                    <div id="fl-bulk-progress" class="pk-card" style="margin-top:8px;padding:9px 10px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                            <span id="fl-bulk-phase" style="color:var(--pk-cyan);min-width:0;flex:1;font-weight:800;font-size:10px;line-height:1.35;">Sẵn sàng</span>
                            <span style="white-space:nowrap;font-weight:800;font-size:10px;opacity:0.9;">Đã hủy: <span id="fl-bulk-unfollow-count" style="color:#fff;font-size:17px;font-weight:900;margin-left:4px;">0</span></span>
                        </div>
                    </div>
                    <div class="pk-card" style="margin-top:8px;flex-shrink:0;">
                        <div class="pk-row" style="margin-bottom:7px;">
                            <span class="pk-label">Delay hủy FL</span>
                            <span id="delay-fl-val-panel" class="pk-val">1.2 s</span>
                        </div>
                        <div id="delay-fl-fixed-wrap-panel" style="display:flex;gap:7px;align-items:center;">
                            <input type="range" id="delay-range-fl-panel" class="delay-slider" min="0.3" max="15" step="0.1" value="1.2" style="flex:1;min-width:0;accent-color:var(--pk-cyan);">
                            <input type="number" id="delay-fl-num-panel" class="pk-input" min="0.3" max="30" step="any" value="1.2" title="giây">
                        </div>
                        <label class="pk-check">
                            <input type="checkbox" id="delay-fl-random-panel" style="width:13px;height:13px;accent-color:var(--pk-cyan);"> Ngẫu nhiên trong khoảng (giây)
                        </label>
                        <div id="delay-fl-random-wrap-panel" style="display:none;flex-wrap:wrap;gap:7px;align-items:center;margin-top:7px;">
                            <span style="font-size:8px;opacity:0.45;">Min</span>
                            <input type="number" id="delay-fl-min-panel" class="pk-input" min="0.2" max="30" step="any" value="0.8">
                            <span style="font-size:8px;opacity:0.45;">Max</span>
                            <input type="number" id="delay-fl-max-panel" class="pk-input" min="0.2" max="30" step="any" value="2.5">
                        </div>
                    </div>
                    <p class="pk-hint">Bốn bước: mở <strong>Đang follow</strong> → chỉ <strong>cuộn để load</strong> → <strong>chờ danh sách ổn định</strong> → <strong>hủy từng người</strong> (delay đồng bộ tab Set). Bỏ qua Bạn bè.</p>
                    <div id="following-list" class="list-scroll" style="margin-top:6px;"></div>
                </div>
                <div id="panel-settings" style="display:none;flex-direction:column;height:100%;">
                    <div class="pk-card">
                        <div class="pk-row">
                            <span class="pk-label">Delay · Repost / Fav</span>
                            <span id="delay-val" class="pk-val">1.2 s</span>
                        </div>
                        <div style="display:flex;gap:8px;align-items:center;">
                            <input type="range" id="delay-range" class="delay-slider" min="0.2" max="10" step="0.1" value="1.2" style="flex:1;min-width:0;accent-color:var(--pk-cyan);">
                            <input type="number" id="delay-general-num" class="pk-input pk-input--wide" min="0.2" max="60" step="any" value="1.2" title="giây">
                        </div>
                        <p class="pk-hint">Đơn vị giây (vd. 1.2 hoặc 2,5).</p>
                    </div>
                    <div class="pk-card">
                        <div class="pk-row">
                            <span class="pk-label">Delay · Hủy follow</span>
                            <span id="delay-fl-val" class="pk-val">1.2 s</span>
                        </div>
                        <div id="delay-fl-fixed-wrap" style="display:flex;gap:8px;align-items:center;">
                            <input type="range" id="delay-range-fl" class="delay-slider" min="0.3" max="15" step="0.1" value="1.2" style="flex:1;min-width:0;accent-color:var(--pk-cyan);">
                            <input type="number" id="delay-fl-num" class="pk-input pk-input--wide" min="0.3" max="30" step="any" value="1.2" title="giây">
                        </div>
                        <label class="pk-check">
                            <input type="checkbox" id="delay-fl-random" style="width:14px;height:14px;accent-color:var(--pk-cyan);"> Ngẫu nhiên min–max mỗi lần hủy
                        </label>
                        <div id="delay-fl-random-wrap" style="display:none;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;">
                            <span style="font-size:8px;opacity:0.45;">Min</span>
                            <input type="number" id="delay-fl-min" class="pk-input pk-input--wide" min="0.2" max="30" step="any" value="0.8">
                            <span style="font-size:8px;opacity:0.45;">Max</span>
                            <input type="number" id="delay-fl-max" class="pk-input pk-input--wide" min="0.2" max="30" step="any" value="2.5">
                        </div>
                        <p class="pk-hint">Tab FL dùng cùng giá trị. Tăng delay nếu bị giới hạn hành động.</p>
                    </div>
                </div>
            </div>
            <div class="ui-foot">
                <div class="ui-foot__meta">
                    <img src="${dImg}" class="ui-foot__img" alt="">
                    <div style="min-width:0;">
                        <div id="dev-n" class="ui-foot__name">${h2s(_v.k)}</div>
                        <div class="ui-foot__ver">TRU PREMIUM V4.5</div>
                    </div>
                </div>
                <div class="ui-foot__links">
                    <a class="ui-foot__a" href="${h2s(_v.f)}" target="_blank" rel="noopener">FB</a>
                    <a class="ui-foot__a" href="${h2s(_v.i)}" target="_blank" rel="noopener">IG</a>
                </div>
            </div>
        `;
        document.body.appendChild(ui);
        const slider = document.getElementById('delay-range'); const valLabel = document.getElementById('delay-val');
        const sliderFl = document.getElementById('delay-range-fl'); const valFl = document.getElementById('delay-fl-val');
        const numGen = document.getElementById('delay-general-num'); const numFl = document.getElementById('delay-fl-num');
        const ckFlRand = document.getElementById('delay-fl-random'); const wrapFlFixed = document.getElementById('delay-fl-fixed-wrap');
        const wrapFlRand = document.getElementById('delay-fl-random-wrap'); const flMin = document.getElementById('delay-fl-min'); const flMax = document.getElementById('delay-fl-max');
        const sliderFlPanel = document.getElementById('delay-range-fl-panel'); const valFlPanel = document.getElementById('delay-fl-val-panel');
        const numFlPanel = document.getElementById('delay-fl-num-panel'); const ckFlRandPanel = document.getElementById('delay-fl-random-panel');
        const wrapFlFixedPanel = document.getElementById('delay-fl-fixed-wrap-panel'); const wrapFlRandPanel = document.getElementById('delay-fl-random-wrap-panel');
        const flMinPanel = document.getElementById('delay-fl-min-panel'); const flMaxPanel = document.getElementById('delay-fl-max-panel');
        const LS = { g: 'tiktok_tru_delay_general', fl: 'tiktok_tru_delay_fl', flR: 'tiktok_tru_delay_fl_rand', flLo: 'tiktok_tru_delay_fl_min', flHi: 'tiktok_tru_delay_fl_max' };

        function persistFlFixedSliderMs() {
            let ms = parseSecStrToMs(numFl?.value, 300, 30000);
            if (ms == null) ms = parseSecStrToMs(sliderFl?.value, 300, 30000) ?? 1200;
            return Math.min(15000, Math.max(300, ms));
        }

        function saveDelayPrefs() {
            try {
                localStorage.setItem(LS.g, String(getProcessingDelayMs()));
                localStorage.setItem(LS.fl, String(persistFlFixedSliderMs()));
                localStorage.setItem(LS.flR, ckFlRand?.checked ? '1' : '0');
                if (flMin) localStorage.setItem(LS.flLo, String(parseSecStrToMs(flMin.value, 200, 30000) ?? 800));
                if (flMax) localStorage.setItem(LS.flHi, String(parseSecStrToMs(flMax.value, 200, 30000) ?? 2500));
            } catch (e) { }
        }

        function loadDelayPrefs() {
            try {
                let gv = localStorage.getItem(LS.g);
                let gMs = gv ? parseInt(gv, 10) : NaN;
                if (!Number.isFinite(gMs) || gMs < 50) gMs = 1200;
                const gSec = msToDisplayedSec(gMs);
                const sliderGms = Math.min(10000, Math.max(300, Math.round(gSec * 1000)));
                if (slider) slider.value = formatDelaySec(sliderGms / 1000);
                if (numGen) numGen.value = formatDelaySec(gSec);
                if (valLabel) valLabel.innerText = formatDelaySec(gSec) + ' s';
                let fv = localStorage.getItem(LS.fl);
                let fMs = (fv != null && fv !== '') ? parseInt(fv, 10) : NaN;
                if (!Number.isFinite(fMs) || fMs < 50) fMs = gMs;
                const fSec = msToDisplayedSec(fMs);
                const sliderFms = Math.min(15000, Math.max(300, Math.round(fSec * 1000)));
                const flDisp = formatDelaySec(fSec);
                const flSlide = formatDelaySec(sliderFms / 1000);
                if (sliderFl) sliderFl.value = flSlide;
                if (sliderFlPanel) sliderFlPanel.value = flSlide;
                if (numFl) numFl.value = flDisp;
                if (numFlPanel) numFlPanel.value = flDisp;
                if (valFl) valFl.innerText = flDisp + ' s';
                if (valFlPanel) valFlPanel.innerText = flDisp + ' s';
                if (localStorage.getItem(LS.flR) === '1') {
                    if (ckFlRand) ckFlRand.checked = true;
                    if (ckFlRandPanel) ckFlRandPanel.checked = true;
                }
                const lm = localStorage.getItem(LS.flLo);
                const hm = localStorage.getItem(LS.flHi);
                let lmMs = lm != null ? parseInt(lm, 10) : 800;
                let hmMs = hm != null ? parseInt(hm, 10) : 2500;
                if (!Number.isFinite(lmMs)) lmMs = 800;
                if (!Number.isFinite(hmMs)) hmMs = 2500;
                if (flMin) flMin.value = formatDelaySec(lmMs / 1000);
                if (flMax) flMax.value = formatDelaySec(hmMs / 1000);
                if (flMinPanel && flMin) flMinPanel.value = flMin.value;
                if (flMaxPanel && flMax) flMaxPanel.value = flMax.value;
            } catch (e) { }
            syncFlRandomUI();
        }

        function syncFlRandomUI() {
            const on = ckFlRand ? ckFlRand.checked : !!(ckFlRandPanel && ckFlRandPanel.checked);
            if (ckFlRandPanel && ckFlRand) ckFlRandPanel.checked = !!on;
            if (wrapFlFixed) wrapFlFixed.style.display = on ? 'none' : 'flex';
            if (wrapFlRand) wrapFlRand.style.display = on ? 'flex' : 'none';
            if (wrapFlFixedPanel) wrapFlFixedPanel.style.display = on ? 'none' : 'flex';
            if (wrapFlRandPanel) wrapFlRandPanel.style.display = on ? 'flex' : 'none';
        }

        function syncGeneralFromSlider() {
            if (!slider) return;
            const sec = clampDelaySec(slider.value, 0.2, 10) ?? 1.2;
            const ms = Math.round(sec * 1000);
            const sliderMs = Math.min(10000, Math.max(300, ms));
            const show = sliderMs / 1000;
            slider.value = formatDelaySec(show);
            if (numGen) numGen.value = formatDelaySec(show);
            if (valLabel) valLabel.innerText = formatDelaySec(show) + ' s';
            saveDelayPrefs();
        }
        function syncGeneralFromNum() {
            if (!slider || !numGen) return;
            const sec = clampDelaySec(numGen.value, 0.2, 60) ?? 1.2;
            const ms = Math.round(sec * 1000);
            const sliderMs = Math.min(10000, Math.max(300, ms));
            numGen.value = formatDelaySec(sec);
            slider.value = formatDelaySec(sliderMs / 1000);
            if (valLabel) valLabel.innerText = formatDelaySec(sec) + ' s';
            saveDelayPrefs();
        }
        function syncFlFromSlider() {
            const raw = (sliderFl && sliderFl.value) ?? (sliderFlPanel && sliderFlPanel.value);
            if (raw == null) return;
            const sec = clampDelaySec(String(raw), 0.3, 15) ?? 1.2;
            const ms = Math.round(sec * 1000);
            const slideMs = Math.min(15000, Math.max(300, ms));
            const sv = formatDelaySec(slideMs / 1000);
            if (sliderFl) sliderFl.value = sv;
            if (sliderFlPanel) sliderFlPanel.value = sv;
            if (numFl) numFl.value = sv;
            if (numFlPanel) numFlPanel.value = sv;
            if (valFl) valFl.innerText = sv + ' s';
            if (valFlPanel) valFlPanel.innerText = sv + ' s';
            saveDelayPrefs();
        }
        function syncFlFromNum(primaryNum) {
            const el = primaryNum || numFl;
            if (!el || (!sliderFl && !sliderFlPanel)) return;
            const sec = clampDelaySec(el.value, 0.3, 30) ?? 1.2;
            const ms = Math.round(sec * 1000);
            const slideMs = Math.min(15000, Math.max(300, ms));
            const numStr = formatDelaySec(sec);
            const slideStr = formatDelaySec(slideMs / 1000);
            if (numFl) numFl.value = numStr;
            if (numFlPanel) numFlPanel.value = numStr;
            if (sliderFl) sliderFl.value = slideStr;
            if (sliderFlPanel) sliderFlPanel.value = slideStr;
            if (valFl) valFl.innerText = numStr + ' s';
            if (valFlPanel) valFlPanel.innerText = numStr + ' s';
            saveDelayPrefs();
        }

        loadDelayPrefs();

        if (slider) {
            slider.oninput = syncGeneralFromSlider;
            slider.onchange = syncGeneralFromSlider;
        }
        if (numGen) {
            numGen.oninput = () => { syncGeneralFromNum(); };
            numGen.onchange = syncGeneralFromNum;
        }

        if (sliderFlPanel) {
            sliderFlPanel.oninput = () => {
                if (sliderFl) sliderFl.value = sliderFlPanel.value;
                syncFlFromSlider();
            };
            sliderFlPanel.onchange = () => {
                if (sliderFl) sliderFl.value = sliderFlPanel.value;
                syncFlFromSlider();
            };
        }
        if (sliderFl) {
            sliderFl.oninput = syncFlFromSlider;
            sliderFl.onchange = syncFlFromSlider;
        }
        if (numFl) {
            numFl.oninput = () => { syncFlFromNum(numFl); };
            numFl.onchange = () => syncFlFromNum(numFl);
        }
        if (numFlPanel) {
            numFlPanel.oninput = () => { syncFlFromNum(numFlPanel); };
            numFlPanel.onchange = () => syncFlFromNum(numFlPanel);
        }
        if (ckFlRand) {
            ckFlRand.onchange = () => {
                if (ckFlRandPanel) ckFlRandPanel.checked = ckFlRand.checked;
                syncFlRandomUI();
                saveDelayPrefs();
            };
        }
        if (ckFlRandPanel) {
            ckFlRandPanel.onchange = () => {
                if (ckFlRand) ckFlRand.checked = ckFlRandPanel.checked;
                syncFlRandomUI();
                saveDelayPrefs();
            };
        }
        syncFlRandomUI();
        [flMin, flMax].forEach(el => {
            if (!el) return;
            el.onchange = () => {
                if (flMinPanel && flMin) flMinPanel.value = flMin.value;
                if (flMaxPanel && flMax) flMaxPanel.value = flMax.value;
                saveDelayPrefs();
            };
        });
        [flMinPanel, flMaxPanel].forEach(el => {
            if (!el) return;
            el.onchange = () => {
                if (flMin && flMinPanel) flMin.value = flMinPanel.value;
                if (flMax && flMaxPanel) flMax.value = flMaxPanel.value;
                saveDelayPrefs();
            };
        });

        if (!window._truUiIntervalId) {
        window._truUiIntervalId = setInterval(() => {
            const icon = document.getElementById('tiktok-minimized-icon');
            const liveInfo = getUserInfo();

            if (!liveInfo.loggedIn) {
                if (ui) ui.style.display = 'none';
                if (icon) icon.style.display = 'none';
                return;
            }

            if (icon && ui && ui.style.display === 'none') {
                icon.style.display = 'flex';
            }

            const header = document.getElementById('ui-header');
            const statusBadge = document.getElementById('ui-profile-status');
            const delBtn = document.getElementById('del-all-btn');
            const unfavBtn = document.getElementById('unfav-all-btn');
            const flFlowBtn = document.getElementById('btn-fl-full-flow');

            if (header) {
                const bulkOn = !!(liveInfo.canBulkActions);
                if (liveInfo.pageKind === 'feed') {
                    if (liveInfo.needsProfileSync) {
                        header.style.background = 'linear-gradient(to bottom, rgba(251,191,36,0.12), transparent)';
                        header.style.borderTop = '4px solid #fbbf24';
                        if (statusBadge) {
                            statusBadge.innerText = 'HỒ SƠ';
                            statusBadge.style.background = '#fbbf24';
                            statusBadge.style.color = '#111';
                        }
                    } else {
                        header.style.background = 'linear-gradient(to bottom, rgba(147,112,219,0.12), transparent)';
                        header.style.borderTop = '4px solid #a78bfa';
                        if (statusBadge) {
                            statusBadge.innerText = 'FYP';
                            statusBadge.style.background = '#a78bfa';
                            statusBadge.style.color = '#fff';
                        }
                    }
                } else if (liveInfo.isOwnProfile) {
                    header.style.background = 'linear-gradient(to bottom, rgba(37,244,238,0.15), transparent)';
                    header.style.borderTop = '4px solid #25F4EE';
                    if (statusBadge) {
                        statusBadge.innerText = 'CHÍNH CHỦ';
                        statusBadge.style.background = '#25F4EE';
                        statusBadge.style.color = '#000';
                    }
                } else {
                    header.style.background = 'linear-gradient(to bottom, rgba(254,44,85,0.15), transparent)';
                    header.style.borderTop = '4px solid #FE2C55';
                    if (statusBadge) {
                        statusBadge.innerText = 'NGƯỜI KHÁC';
                        statusBadge.style.background = '#FE2C55';
                        statusBadge.style.color = '#fff';
                    }
                }
                if (delBtn) delBtn.disabled = !bulkOn;
                if (unfavBtn) unfavBtn.disabled = !bulkOn;
                if (flFlowBtn) flFlowBtn.disabled = !bulkOn;
            }

            refreshTruViewerPanel();

            updateL();
        }, 2800);
        }

        ['repost', 'fav', 'like', 'dl', 'follow', 'settings'].forEach(t => {
            const b = document.getElementById('tab-' + t);
            if (b) b.onclick = () => switchT(t);
        });

        const truVidBtn = document.getElementById('tru-btn-dl-video');
        if (truVidBtn) {
            truVidBtn.onclick = async () => {
                const statusEl = document.getElementById('tru-dl-status');
                const { awemeId, item, video } = getTruFocusedAweme({ force: true });
                let url = item ? truPickVideoDownloadUrl(item) : null;
                const filename = `tiktok_${awemeId || 'video'}.mp4`;
                if (!url && video) {
                    const vsrc = video.currentSrc || video.src || '';
                    if (vsrc && (/^https?:/i.test(vsrc) || /^blob:/i.test(vsrc))) {
                        url = vsrc;
                        if (statusEl) {
                            statusEl.textContent = /^blob:/i.test(vsrc)
                                ? '📎 Tải từ luồng blob (trình phát) — thường có watermark.'
                                : '📎 Dùng URL luồng đang phát — thường có watermark.';
                        }
                    }
                }
                if (!url) {
                    const n = Object.keys(window.truAwemeById || {}).length;
                    if (statusEl) {
                        statusEl.textContent = n === 0
                            ? 'Chưa có URL — extension chưa bắt được item_list (thử vuốt FYP, F5, hoặc mở trang /video/id).'
                            : 'Chưa khớp clip với metadata — vuốt qua clip này lần nữa hoặc mở đúng link /video/id.';
                    }
                    return;
                }
                await truBlobDownload(url, filename, statusEl, '✅ Đã tải xong.', '⚠️ ');
            };
        }
        const truPhBtn = document.getElementById('tru-btn-dl-photos');
        if (truPhBtn) {
            truPhBtn.onclick = async () => {
                const statusEl = document.getElementById('tru-dl-status');
                const { awemeId, item } = getTruFocusedAweme({ force: true });
                const urls = truMergePhotoDownloadUrls(item, window.location.pathname || '');
                if (!urls.length) {
                    if (statusEl) {
                        statusEl.textContent = 'Chưa thấy URL ảnh — F5; hoặc mở đúng /photo/id; carousel cần metadata item_list.';
                    }
                    refreshTruViewerPanel();
                    return;
                }
                if (statusEl) statusEl.textContent = `⏳ Tải ${urls.length} ảnh…`;
                for (let i = 0; i < urls.length; i++) {
                    const u = urls[i];
                    const fn = `tiktok_${awemeId || 'photo'}_${i + 1}${truPhotoFilenameSuffix(u)}`;
                    await truBlobDownload(u, fn, null, '', '');
                    await new Promise(r => setTimeout(r, 280));
                }
                if (statusEl) statusEl.textContent = `✅ Đã tải ${urls.length} ảnh.`;
            };
        }



        const delBtn = document.getElementById('del-all-btn');
        if (delBtn) {
            delBtn.onclick = async () => {
                if (!window.allRepostVideos.length) return;
                const b = delBtn; const delay = getProcessingDelayMs(); b.disabled = true;
                for (let i = 0; i < window.allRepostVideos.length; i++) {
                    const item = window.allRepostVideos[i]; const id = item.id || item.aweme_id;
                    b.innerText = `⏳ ĐANG XÓA ${i + 1}/${window.allRepostVideos.length}`;
                    await window.deleteTiktokRepost(id, document.getElementById('btn-rep-' + id));
                    await new Promise(r => setTimeout(r, delay));
                }
                b.innerText = '✅ HOÀN TẤT'; b.disabled = false;
            };
        }

        const unfavBtn = document.getElementById('unfav-all-btn');
        if (unfavBtn) {
            unfavBtn.onclick = () => {
                if (!window.allFavorites.length) return;
                const ids = window.allFavorites.map(v => v.id || v.aweme_id);
                const first = ids.shift(); localStorage.setItem('tiktok_unfav_queue', JSON.stringify(ids));
                window.open(`https://www.tiktok.com/@user/video/${first}?autounfav=1`, '_blank');
            };
        }

        const btnFlFlow = document.getElementById('btn-fl-full-flow');
        if (btnFlFlow) btnFlFlow.onclick = async () => { await runFlFullUnfollowFlow(btnFlFlow); };


        // --- DRAG & MINIMIZE LOGIC ---
        function makeMovable(el, handle) {
            let p1 = 0, p2 = 0, p3 = 0, p4 = 0;
            handle.onmousedown = (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.id === 'minimize-ui') return;
                p3 = e.clientX; p4 = e.clientY;
                document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
                document.onmousemove = (e) => {
                    p1 = p3 - e.clientX; p2 = p4 - e.clientY; p3 = e.clientX; p4 = e.clientY;
                    el.style.top = (el.offsetTop - p2) + "px";
                    el.style.left = (el.offsetLeft - p1) + "px";
                    el.style.right = 'auto'; el.style.bottom = 'auto';
                };
            };
        }
        makeMovable(ui, document.getElementById('ui-header'));

        const miniIcon = document.createElement('div');
        miniIcon.id = 'tiktok-minimized-icon';
        miniIcon.title = 'Mở lại menu';
        miniIcon.innerHTML = '<span class="tiktok-mini-wave" aria-hidden="true"></span><span class="tiktok-mini-wave tiktok-mini-wave--2" aria-hidden="true"></span><span class="tiktok-mini-wave tiktok-mini-wave--3" aria-hidden="true"></span><canvas id="tru-mini-wave-canvas" aria-hidden="true"></canvas><img id="tiktok-mini-avatar" class="tiktok-mini-avatar" alt="">';
        const miniAv = miniIcon.querySelector('#tiktok-mini-avatar');
        if (miniAv) {
            miniAv.src = info.avatar || defUser;
            miniAv.onerror = () => { miniAv.src = defUser; };
        }
        document.body.appendChild(miniIcon);

        document.getElementById('minimize-ui').onclick = () => {
            ui.style.display = 'none';
            miniIcon.style.display = 'flex';
        };
        miniIcon.onclick = () => {
            ui.style.display = 'flex';
            miniIcon.style.display = 'none';
        };
        makeMovable(miniIcon, miniIcon);

        startTiktokMusicPulse();

        // Auto-refresh info once after loading to catch lazy-loaded avatars
        setTimeout(() => {
            const newInfo = getUserInfo();
            const avatarEl = document.getElementById('ui-user-avatar');
            if (avatarEl && newInfo.avatar && avatarEl.src !== newInfo.avatar) {
                avatarEl.src = newInfo.avatar;
            }
        }, 2000);
    }

    function updateL() {
        if (!document.getElementById('tiktok-repost-ui')) createUI();
        const info = getUserInfo();
        let ui = document.getElementById('tiktok-repost-ui');

        if (info.loggedIn && ui && ui.querySelector('.logged-out-wrap')) {
            const mini = document.getElementById('tiktok-minimized-icon');
            ui.remove();
            if (mini) mini.remove();
            createUI();
            ui = document.getElementById('tiktok-repost-ui');
        }

        if (!info.loggedIn) {
            if (ui && !ui.innerHTML.includes('🔒')) {
                ui.innerHTML = `
                    <div class="logged-out-wrap" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;padding:24px;text-align:center;box-sizing:border-box;">
                        <div style="font-size:48px;line-height:1;">🔒</div>
                        <div class="pk-card" style="max-width:260px;padding:16px;display:flex;flex-direction:column;gap:10px;align-items:center;">
                            <div style="font-size:15px;font-weight:700;color:#FE2C55;letter-spacing:-0.02em;">CHƯA ĐĂNG NHẬP</div>
                            <div class="pk-hint" style="text-align:center;margin:0;">Đăng nhập TikTok để dùng công cụ.</div>
                            <button type="button" onclick="location.reload()" class="main-action" style="margin-top:4px;width:100%;">Thử lại</button>
                        </div>
                    </div>
                `;
            }
            return;
        }

        const headerImg = document.getElementById('ui-user-avatar');
        const nick = document.getElementById('ui-user-nickname');
        const user = document.getElementById('ui-user-username');

        if (headerImg && info.avatar && info.avatar.includes('http') && !headerImg.src.includes(info.avatar.split('?')[0])) {
            headerImg.src = info.avatar;
            const miniA = document.getElementById('tiktok-mini-avatar');
            if (miniA) miniA.src = info.avatar;
        }
        if (nick) nick.innerText = info.nickname;
        if (user) user.innerText = info.username;

        const statGridEl = ui.querySelector('.stat-grid');
        const syncBanner = document.getElementById('tru-sync-banner');
        if (info.needsProfileSync && statGridEl) {
            if (!syncBanner) {
                const b = document.createElement('div');
                b.id = 'tru-sync-banner';
                b.className = 'pk-card';
                b.style.cssText = 'margin-left:10px;margin-right:10px;margin-bottom:8px;margin-top:2px;padding:9px 11px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.4);flex-shrink:0;font-size:9px;line-height:1.45;color:rgba(255,255,255,0.9);';
                b.innerHTML = '<strong style="color:#fcd34d;display:block;margin-bottom:4px;">Chỉ một lần sau khi cài</strong>Mở trang <span style="color:#25F4EE;font-weight:800">Hồ sơ của bạn</span> để lưu avatar & số liệu; sau đó dùng Repost / Unfav / FL ở mọi trang (kể cả FYP).';
                statGridEl.parentNode.insertBefore(b, statGridEl);
            }
        } else if (syncBanner) {
            syncBanner.remove();
        }

        const rl = document.getElementById('repost-list');
        if (rl && window.allRepostVideos.length > rl.children.length) {
            window.allRepostVideos.slice(rl.children.length).forEach(item => {
                const id = item.id || item.aweme_id; if (!id || document.getElementById('btn-rep-' + id)) return;
                const c = document.createElement('div'); c.className = 'item-glass';
                c.innerHTML = `<div style="overflow:hidden;flex-grow:1;min-width:0;"><div style="font-size:12px;font-weight:900;color:var(--pk-cyan);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">@${item.author?.uniqueId || 'user'}</div><div class="video-desc">${item.desc || 'No description provided'}</div></div>`;
                const b = document.createElement('button'); b.id = 'btn-rep-' + id; b.style.cssText = 'background:rgba(255,255,255,0.06);border:none;color:#fff;width:42px;height:42px;border-radius:12px;font-size:16px;cursor:pointer;transition:all 0.2s;flex-shrink:0;'; b.innerText = '🗑️';
                b.onmouseover = () => { b.style.background = 'rgba(254,44,85,0.2)'; b.style.transform = 'scale(1.1)'; }; b.onmouseout = () => { b.style.background = 'rgba(255,255,255,0.06)'; b.style.transform = 'scale(1)'; };
                b.onclick = () => window.deleteTiktokRepost(id, b); c.appendChild(b); rl.appendChild(c);
            });
        }
        const fl = document.getElementById('fav-list');
        if (fl && window.allFavorites.length > fl.children.length) {
            window.allFavorites.slice(fl.children.length).forEach(item => {
                const id = item.id || item.aweme_id; if (!id || document.getElementById('btn-fav-' + id)) return;
                const c = document.createElement('div'); c.className = 'item-glass';
                c.innerHTML = `<div style="overflow:hidden;flex-grow:1;min-width:0;"><div style="font-size:12px;font-weight:900;color:var(--pk-red);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">@${item.author?.uniqueId || 'user'}</div><div class="video-desc">${item.desc || 'No description provided'}</div></div>`;
                const b = document.createElement('button'); b.id = 'btn-fav-' + id; b.style.cssText = 'background:rgba(255,255,255,0.06);border:none;color:#fff;width:42px;height:42px;border-radius:12px;font-size:16px;cursor:pointer;transition:all 0.2s;flex-shrink:0;'; b.innerText = '🗑️';
                b.onmouseover = () => { b.style.background = 'rgba(254,44,85,0.2)'; b.style.transform = 'scale(1.1)'; }; b.onmouseout = () => { b.style.background = 'rgba(255,255,255,0.06)'; b.style.transform = 'scale(1)'; };
                b.onclick = () => window.unfavoriteTiktokVideo(id, b); c.appendChild(b); fl.appendChild(c);
            });
        }
        const ll = document.getElementById('like-list');
        if (ll && window.allLikedVideos.length > ll.children.length) {
            window.allLikedVideos.slice(ll.children.length).forEach(item => {
                const id = item.id || item.aweme_id; if (!id || document.getElementById('btn-like-' + id)) return;
                const c = document.createElement('div'); c.className = 'item-glass';
                c.innerHTML = `<div style="overflow:hidden;flex-grow:1;min-width:0;"><div style="font-size:12px;font-weight:900;color:#FACE15;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">@${item.author?.uniqueId || 'user'}</div><div class="video-desc">${item.desc || 'No description provided'}</div></div>`;
                const b = document.createElement('button'); b.id = 'btn-like-' + id; b.style.cssText = 'background:rgba(255,255,255,0.06);border:none;color:#fff;width:42px;height:42px;border-radius:12px;font-size:16px;cursor:pointer;transition:all 0.2s;flex-shrink:0;'; b.innerText = '🗑️';
                b.onmouseover = () => { b.style.background = 'rgba(254,44,85,0.2)'; b.style.transform = 'scale(1.1)'; }; b.onmouseout = () => { b.style.background = 'rgba(255,255,255,0.06)'; b.style.transform = 'scale(1)'; };
                b.onclick = () => window.unlikeTiktokVideo(id, b); c.appendChild(b); ll.appendChild(c);
            });
        }
        const fgl = document.getElementById('following-list');
        if (fgl && window.allFollowing.length > fgl.children.length) {
            window.allFollowing.slice(fgl.children.length).forEach(entry => {
                const u = entry.user || entry;
                const sec = u.secUid || u.sec_uid;
                const uid = u.uniqueId || u.unique_id || '';
                if (!sec || !uid || document.getElementById(safeUnfBtnId(sec))) return;
                const c = document.createElement('div'); c.className = 'item-glass';
                c.innerHTML = `<div style="display:flex;align-items:center;gap:15px;min-width:0;flex-grow:1;"><img src="${u.avatarThumb}" style="width:42px;height:42px;border-radius:15px;background:#222;border:1px solid rgba(255,255,255,0.1);flex-shrink:0;"><div style="overflow:hidden;min-width:0;flex-grow:1;"><div style="font-size:13px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${u.nickname}</div><div style="font-size:10px;color:var(--pk-cyan);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">@${u.uniqueId}</div></div></div>`;
                const b = document.createElement('button'); b.id = safeUnfBtnId(sec); b.style.cssText = 'background:rgba(255,255,255,0.06);border:none;color:#fff;width:42px;height:42px;border-radius:12px;font-size:16px;cursor:pointer;transition:all 0.2s;flex-shrink:0;'; b.innerText = '🚫';
                b.onmouseover = () => { b.style.background = 'rgba(254,44,85,0.2)'; b.style.transform = 'scale(1.1)'; }; b.onmouseout = () => { b.style.background = 'rgba(255,255,255,0.06)'; b.style.transform = 'scale(1)'; };
                b.onclick = () => unfollowTiktokUserDom(uid, b);
                c.appendChild(b); fgl.appendChild(c);
            });
        }
    }

    window.fetch = async function () {
        const args = Array.prototype.slice.call(arguments); const res = await originalFetch.apply(this, args);
        const url = (args[0] instanceof Request ? args[0].url : args[0]) || '';

        const isRepost = url.includes('/api/repost/item_list/');
        const isFav = url.includes('/api/user/collect/item_list/');
        let isFollowingApi = url.includes('/api/user/following') || url.includes('following/list');
        if (url.includes('/api/user/list/')) {
            try {
                const lu = url.startsWith('http') ? url : location.origin + url;
                const uu = new URL(lu);
                const scene = (uu.searchParams.get('scene') || '').toLowerCase();
                if (scene === 'following') isFollowingApi = true;
            } catch (err) { }
        }

        const truFeedApi = truIsLikelyAwemeFeedApi(url);
        if (truFeedApi) {
            res.clone().json().then((d) => {
                truProcessFeedJsonPayload(d);
            }).catch(() => { });
        }

        if (isRepost || isFav || isFollowingApi) {
            res.clone().json().then(d => {
                if (d.itemList) {
                    truIngestAwemeItems(d.itemList);
                    if (isRepost) { window.allRepostVideos.push(...d.itemList); }
                    if (isFav) { window.allFavorites.push(...d.itemList); }
                    updateL();
                }
                if (isFollowingApi && d.userList) {
                    try {
                        const lu = url.startsWith('http') ? url : location.origin + url;
                        window.tiktokLastFollowingUrlObj = new URL(lu);
                    } catch (err) { }
                    dedupeFollowingPush(d.userList);
                    updateL();
                }
                if (isRepost) {
                    window.tiktokLastUrlObj = new URL(url.startsWith('http') ? url : location.origin + url);
                }
            }).catch(e => console.error("Extension Error parsing JSON:", e));
        }
        return res;
    };

    function activateExtensionUI() {
        if (window.tiktokExtensionActivated) return;
        window.tiktokExtensionActivated = true;
        createUI();
        updateL();
    }

    setTimeout(() => {
        try {
            if (getUserInfo().loggedIn) activateExtensionUI();
        } catch (e) { /* đợi DOM TikTok */ }
    }, 2000);

    document.addEventListener('click', () => { activateExtensionUI(); }, { once: true });
})();