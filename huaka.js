// Port of the request flow in https://github.com/Nakami003/huaka-mihon
class Huaka extends ComicSource {
    name = "花咔漫画";
    key = "huaka";
    version = "1.0.1";
    minAppVersion = "1.4.0";
    url = "https://raw.githubusercontent.com/Nakami003/Fujyoshi-VeneraNext/main/huaka.js";
    base = "https://app.huakacomic.com";
    home = this.base + "/zh-CN";

    detail(id) { return this.home + "/comics/" + encodeURIComponent(id); }
    chapter(id, ep) { return this.detail(id) + "/episodes/" + encodeURIComponent(ep); }
    cover(value) {
        if (!value || /^https?:\/\//i.test(value)) return value || "";
        return value.startsWith("//") ? "https:" + value : this.base + "/" + value.replace(/^\//, "");
    }

    async get(url, referer, headers = {}) {
        const response = await Network.get(url, { Referer: referer, ...headers });
        if (response.status === 401 || response.status === 403) {
            throw new Error("花咔拒绝访问，请检查官网登录状态和作品权限。");
        }
        if (response.status !== 200) throw new Error("花咔 HTTP " + response.status);
        return response.body;
    }

    async api(route, params, referer) {
        const query = Object.entries(params).filter(([, value]) => value != null && value !== "")
            .map(([key, value]) => key + "=" + encodeURIComponent(value)).join("&");
        const body = JSON.parse(await this.get(this.base + "/api/bff/" + route + "?" + query, referer,
            { Accept: "application/json" }));
        if (body.statusCode !== 200 || !body.data) throw new Error(body.message || "花咔没有返回数据。");
        return body.data;
    }

    account = {
        loginWithWebview: {
            url: this.home + "/login?redirect=%2Fzh-CN%2Fannouncements",
            checkStatus: url => url.split(/[?#]/)[0] === this.home + "/announcements",
            onLoginSuccess: async () => {
                await this.get(this.base + "/api/bff/users/me?profileRefresh=1", this.home);
            },
        },
    };

    explore = [{
        title: "花咔漫画",
        type: "multiPageComicList",
        load: async page => {
            if (page > 1) return { comics: [], maxPage: 1 };
            const url = this.home + "/latest";
            const document = new HtmlDocument(await this.get(url, this.home));
            const comics = [];
            const seen = new Set();
            try {
                for (const link of document.querySelectorAll('a[href*="/comics/"]')) {
                    const match = /^(?:https:\/\/app\.huakacomic\.com)?\/zh-CN\/comics\/([^/?#]+)[\/?#]?$/.exec(
                        link.attributes.href.split(/[?#]/)[0].replace(/\/$/, "")
                    );
                    if (!match || seen.has(match[1])) continue;
                    const img = link.querySelector("img")?.attributes || {};
                    const title = (link.querySelector("h2, h3, h4, h5")?.text || img.alt || link.attributes.title || link.text || "").trim();
                    if (!title) continue;
                    seen.add(match[1]);
                    comics.push(new Comic({ id: decodeURIComponent(match[1]), title,
                        cover: this.cover(img["data-src"] || img.src) }));
                }
            } finally {
                document.dispose();
            }
            if (!comics.length) throw new Error("花咔最近更新页没有返回可识别的漫画。");
            return { comics, maxPage: 1 };
        },
    }];

    search = {
        optionList: [
            { label: "分类", type: "select", default: 0,
                options: ["all-全部", "短篇-短篇", "長篇-长篇", "全彩-全彩", "同人-同人", "純愛-纯爱", "單行本-单行本"] },
            { label: "排序", type: "select", default: 0,
                options: ["relevance-相关度", "latest-最近更新", "most_read-最多阅读",
                    "most_bookmarked-最多收藏", "most_liked-最多点赞"] },
        ],
        loadNext: async (keyword, options, next) => {
            const query = keyword.trim();
            const categories = options?.[0] === "all" ? "" : options?.[0];
            if (!query && !categories) return { comics: [], next: null };
            const sort = options?.[1] || "relevance";
            const referer = query ? this.home + "/search?query=" + encodeURIComponent(query)
                : this.home + "/categories/" + encodeURIComponent(categories);
            const data = await this.api("comic-search", { query, categories, sort, pageSize: 20, pageToken: next }, referer);
            return {
                comics: data.comics.map(entry => new Comic({
                    id: entry.huaCode || entry.id, title: entry.title, cover: this.cover(entry.thumbnailUrl),
                    subTitle: (entry.authors || []).join("、"), tags: [...(entry.categories || []), ...(entry.tags || [])],
                })),
                next: data.nextPageToken && data.nextPageToken !== next ? data.nextPageToken : null,
            };
        },
    };

    // Flight rows carry structured JSON followed by references to other rows.
    flightObjects(body) {
        const rows = new Map();
        for (const line of body.split("\n")) {
            const match = /^([0-9a-f]+):(.*)$/i.exec(line);
            if (!match) continue;
            try { rows.set(match[1], JSON.parse(match[2])); } catch { /* Non-JSON Flight record. */ }
        }
        const resolve = (value, seen = new Set()) => {
            if (typeof value !== "string") return value;
            if (value === "$undefined") return null;
            if (value.startsWith("$$")) return value.slice(1);
            const ref = /^\$[@L]?([0-9a-f]+)(?::(.*))?$/i.exec(value);
            if (!ref || !rows.has(ref[1]) || seen.has(ref[1])) return value;
            const target = (ref[2]?.split(":") || []).reduce((node, key) => node?.[key], rows.get(ref[1]));
            return resolve(target, new Set([...seen, ref[1]]));
        };
        const objects = [];
        const visit = value => {
            if (!value || typeof value !== "object") return;
            if (!Array.isArray(value)) {
                const item = Object.fromEntries(Object.entries(value).map(([key, field]) => [key, resolve(field)]));
                if (Array.isArray(item.initialEpisodes)) item.initialEpisodes = item.initialEpisodes.map(ep => resolve(ep));
                objects.push(item);
            }
            Object.values(value).forEach(visit);
        };
        rows.forEach(visit);
        return objects;
    }

    comic = {
        loadInfo: async id => {
            const url = this.detail(id);
            const objects = this.flightObjects(await this.get(url + "?_rsc=", url, { RSC: "1", Accept: "text/x-component" }));
            const directory = objects.find(item => Array.isArray(item.initialEpisodes) && item.comicId);
            if (!directory) throw new Error("无法读取花咔章节目录。");
            if (directory.initialNextPageToken || directory.initialTotalCount > directory.initialEpisodes.length) {
                throw new Error("此漫画的章节目录需要额外分页，当前版本尚不支持。");
            }
            const metadata = objects.find(item => item.title && "thumbnailUrl" in item) || {};
            const identity = objects.find(item => item.comic && "visibility" in item)?.comic || {};
            const description = objects.find(item => typeof item.text === "string" && "collapsedClassName" in item)?.text;
            const chapters = {};
            for (const ep of [...directory.initialEpisodes].sort((a, b) => a.order - b.order)) {
                chapters["ep_" + ep.id] = ep.title;
            }
            return new ComicDetails({ title: metadata.title || id, cover: this.cover(metadata.thumbnailUrl), url,
                tags: { 作者: identity.authors || [], 标签: identity.tags || [] }, description, chapters });
        },
        loadEp: async (id, chapterKey) => {
            const episodeId = chapterKey.slice(3);
            const referer = this.chapter(id, episodeId);
            const images = [];
            const seen = new Set();
            let pageToken;
            do {
                const data = await this.api("comic-pages", { episodeId, pageSize: 25, mediaSize: "read", pageToken }, referer);
                images.push(...data.pages.map(page => this.cover(page.mediaUrl)).filter(Boolean));
                pageToken = data.nextPageToken;
                if (pageToken) {
                    if (seen.has(pageToken) || seen.size >= 100) throw new Error("花咔图片分页异常。");
                    seen.add(pageToken);
                }
            } while (pageToken);
            if (!images.length) throw new Error("花咔没有返回正文图片。");
            return { images };
        },
        onImageLoad: (url, id, ep) => ({ url, headers: { Referer: this.chapter(id, ep.slice(3)) } }),
        onThumbnailLoad: url => ({ url, headers: { Referer: this.home + "/" } }),
    };
}
