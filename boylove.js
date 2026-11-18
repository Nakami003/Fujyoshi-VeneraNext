// VeneraNext port based on Keiyoushi's BoyLove extension (Apache-2.0).
// https://github.com/keiyoushi/extensions-source/tree/f1d882a93ef34a33dc4f4467753ad5f99eab43f4/src/zh/boylove
class BoyLove extends ComicSource {
    name = "香香腐宅";
    key = "boylove";
    version = "1.0.0";
    minAppVersion = "1.4.0";
    url = "https://raw.githubusercontent.com/Nakami003/Fujyoshi-VeneraNext/main/boylove.js";
    base = "https://boylove.cc";
    imageHost = "https://blcnimghost2.cc";
    entries = new Map();

    async get(path, headers) {
        const response = await Network.get(this.base + path, { Referer: this.base + "/", ...headers });
        if (response.status !== 200) throw new Error("香香腐宅 HTTP " + response.status);
        return response.body;
    }

    async api(path) {
        const result = JSON.parse(await this.get(path, { "X-Requested-With": "XMLHttpRequest" })).result;
        if (!result) throw new Error("香香腐宅没有返回数据。");
        return result;
    }

    imageUrl(path) {
        if (!path || /^https?:\/\//i.test(path)) return path || "";
        if (path.startsWith("//")) return "https:" + path;
        return this.imageHost + "/" + path.replace(/^\//, "");
    }

    remember(entry) {
        const id = String(entry.id);
        if (this.entries.size >= 500) this.entries.delete(this.entries.keys().next().value);
        this.entries.set(id, entry);
        return new Comic({ id, title: entry.title, cover: this.imageUrl(entry.image), subTitle: entry.auther || "" });
    }

    searchPath(keyword, page) {
        return "/home/api/searchk?keyword=" + encodeURIComponent(keyword) + "&type=1&pageNo=" + page;
    }

    async list(path, page) {
        const data = await this.api(path);
        return { comics: (data.list || []).map(entry => this.remember(entry)), maxPage: page + (data.lastPage ? 0 : 1) };
    }

    search = {
        load: (keyword, options, page) => keyword.trim()
            ? this.list(this.searchPath(keyword.trim(), page), page)
            : this.list("/home/api/getpage/tp/1-topestmh-" + (page - 1), page),
    };

    explore = [{
        title: "热门",
        type: "multiPageComicList",
        load: page => this.list("/home/api/getpage/tp/1-topestmh-" + (page - 1), page),
    }, {
        title: "最近更新",
        type: "multiPageComicList",
        load: async page => {
            const list = await this.api("/home/Api/getDailyUpdate.html?widx=4&page=" + (page - 1) + "&limit=10");
            return { comics: list.map(entry => this.remember(entry)), maxPage: page + (list.length >= 10 ? 1 : 0) };
        },
    }];

    comic = {
        loadInfo: async id => {
            const encoded = encodeURIComponent(id);
            const path = "/home/book/index/id/" + encoded;
            let entry = this.entries.get(id);
            if (!entry || !entry.desc) {
                const document = new HtmlDocument(await this.get(path));
                let title;
                try {
                    title = entry?.title || document.querySelector('meta[property="og:title"]')?.attributes.content
                        || document.querySelector("h1")?.text || document.querySelector("title")?.text;
                } finally {
                    document.dispose();
                }
                if (title) {
                    const data = await this.api(this.searchPath(title.trim(), 1));
                    entry = data.list?.find(item => String(item.id) === id) || entry || { title };
                }
            }
            const data = await this.api("/home/api/chapter_list/tp/" + encoded);
            const chapters = {};
            for (const chapter of (data.list || []).slice().reverse()) {
                chapters["ep_" + chapter.id] = chapter.title.trim();
            }
            const updateTime = typeof entry?.update_time === "number"
                ? new Date(entry.update_time * 1000).toISOString() : entry?.update_time;
            return new ComicDetails({
                title: entry?.title || id, cover: this.imageUrl(entry?.image), description: entry?.desc,
                tags: { 作者: entry?.auther ? [entry.auther] : [], 标签: (entry?.keyword || "").split(",").filter(Boolean) },
                url: this.base + path, updateTime, chapters,
            });
        },
        loadEp: async (id, ep) => {
            const doc = new HtmlDocument(await this.get(this.chapterPath(ep)));
            try {
                const section = doc.querySelector("section");
                if (!section) throw new Error("无法读取正文，请检查章节是否需要登录或会员权限。");
                const lazy = section.querySelectorAll(".reader-cartoon-image");
                const images = lazy.length ? lazy.flatMap(element => {
                    const attrs = element.querySelector("img")?.attributes;
                    return attrs?.src?.endsWith("load.png") && attrs["data-original"]
                        ? [this.imageUrl(attrs["data-original"].trim())] : [];
                }) : section.querySelectorAll("img").map(el => this.imageUrl(el.attributes.src?.trim()))
                    .filter(url => url && !/\.gif(?:\?|$)/i.test(url));
                const script = doc.querySelectorAll("script").map(el => el.innerHTML)
                    .find(body => body.includes("firstMergeImg") && body.includes("imageData"));
                const assignment = script?.split("var scrollTop")[0].split(/var\s+randomClass\s*=\s*/).pop()?.split(";")[0];
                const parts = Number(assignment?.match(/(\d+)\s*$/)?.[1]);
                if (!images.length) throw new Error("香香腐宅没有返回正文图片。");
                return { images: images.map(url => parts > 1 ? "boylove:" + parts + ":" + url : url) };
            } finally {
                doc.dispose();
            }
        },
        onImageLoad: (key, id, ep) => {
            const marker = /^boylove:(\d+):(.+)$/.exec(key);
            const config = { url: marker ? marker[2] : key, headers: { Referer: this.base + this.chapterPath(ep) } };
            if (marker) config.modifyImage = this.reorder(Number(marker[1]));
            return config;
        },
    };

    chapterPath(key) { return "/home/book/capter/id/" + encodeURIComponent(key.slice(3)); }

    reorder(parts) {
        return "function modifyImage(image) {\n" +
            "  const parts = " + parts + ";\n" +
            "  const { width, height } = image;\n" +
            "  if (height >= 4000 || parts > width) return image;\n" +
            "  const output = Image.empty(width, height);\n" +
            "  const strip = Math.floor(width / parts);\n" +
            "  for (let i = 1; i < parts; i++) {\n" +
            "    output.fillImageRangeAt((i - 1) * strip, 0, image, width - i * strip, 0, strip, height);\n" +
            "  }\n" +
            "  const tail = strip * (parts - 1);\n" +
            "  output.fillImageRangeAt(tail, 0, image, 0, 0, width - tail, height);\n" +
            "  return output;\n" +
            "}";
    }
}
