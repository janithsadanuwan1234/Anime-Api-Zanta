const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const yts = require('yt-search');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & SHARED CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const SHARED_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
};

const SINHALASUB_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Referer': 'https://sinhalasub.lk/'
};

// ─────────────────────────────────────────────────────────────────────────────
// COOKIE JAR (for Cinesubz)
// ─────────────────────────────────────────────────────────────────────────────
const jar = new CookieJar();
const cookieClient = wrapper(axios.create({ jar, withCredentials: true }));

// ─────────────────────────────────────────────────────────────────────────────
// KISSKH COOKIE CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const KISSKH_BASE = "https://kisskh.do";
const KISSKH_API  = "https://kisskh.do/api";
const KISSKH_COOKIE = "_ga=GA1.1.2050396191.1777544387; _ga_R3CRN9FY5Q=GS2.1.s1777544387$o1$g1$t1777544648$j60$l0$h0";

const kisskhJar = new CookieJar();
const kisskhClient = wrapper(axios.create({ jar: kisskhJar }));

if (KISSKH_COOKIE) {
    KISSKH_COOKIE.split('; ').forEach(cookie => {
        const [name, ...v] = cookie.split('=');
        const value = v.join('=');
        if (name && value) {
            try { kisskhJar.setCookieSync(`${name}=${value}`, KISSKH_BASE); } catch (e) {}
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMEHEAVEN CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const ANIME_BASE = 'https://animeheaven.me';
const getAnimeHeaders = () => ({
    'User-Agent': USER_AGENT,
    'Referer': ANIME_BASE,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Cookie': 'key=4290d2719374dd27249ad2886fb0076e;'
});

// ─────────────────────────────────────────────────────────────────────────────
// PUPPETEER LAUNCHER — Render compatible (no executablePath)
// ─────────────────────────────────────────────────────────────────────────────
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process'
];

async function launchBrowser() {
    return await puppeteer.launch({
        headless: true,
        args: PUPPETEER_ARGS
        // NO executablePath — Render downloads Chromium automatically via puppeteer package
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// FITGIRL — Search
// ─────────────────────────────────────────────────────────────────────────────
async function searchGames(query) {
    try {
        const { data } = await axios.get(`https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`);
        const $ = cheerio.load(data);
        let results = [];
        $('article').each((_, el) => {
            const a = $(el).find('h1.entry-title a');
            if (a.text()) results.push({ title: a.text().trim(), url: a.attr('href') });
        });
        return { success: true, results };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FITGIRL — Get DataNodes file links
// ─────────────────────────────────────────────────────────────────────────────
async function getGameFiles(gameUrl) {
    try {
        const { data } = await axios.get(gameUrl);
        const $ = cheerio.load(data);

        let pageImageUrl = $('.entry-content img').first().attr('src') || "";
        let finalImageUrl = pageImageUrl;

        if (pageImageUrl.includes('imageban.ru')) {
            try {
                const imgPage = await axios.get(pageImageUrl);
                const $img = cheerio.load(imgPage.data);
                const directImg = $img('#img_obj').attr('src') || $img('img[src*="/out/"]').attr('src');
                if (directImg) finalImageUrl = directImg;
            } catch (e) {}
        }

        let links = [];
        $('a').each((_, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('datanodes.to')) {
                links.push({ name: $(el).text().trim() || "Download Part", url: href });
            }
        });

        return { success: true, image: finalImageUrl, files: links };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FITGIRL — DataNodes direct link via Puppeteer
// ─────────────────────────────────────────────────────────────────────────────
async function getDirectDownload(dataNodesUrl) {
    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);

        let capturedUrl = null;

        page.on('request', request => {
            if (request.url().includes('dlproxy.uk/download/')) {
                capturedUrl = request.url();
            }
        });

        browser.on('targetcreated', async (target) => {
            if (target.type() === 'page') {
                const adPage = await target.page();
                if (adPage && !adPage.url().includes('datanodes.to')) {
                    await adPage.close().catch(() => {});
                    await page.bringToFront();
                }
            }
        });

        await page.goto(dataNodesUrl, { waitUntil: 'domcontentloaded' });

        const btnSelector = 'button.bg-blue-600';
        await page.waitForSelector(btnSelector, { timeout: 10000 });

        // Trigger countdown
        for (let i = 0; i < 4; i++) {
            await page.evaluate(sel => document.querySelector(sel).click(), btnSelector);
            await delay(3000);
            const isCounting = await page.evaluate(() => {
                const txt = document.body.innerText.toLowerCase();
                return txt.includes('wait') || txt.includes('seconds');
            });
            if (isCounting) break;
        }

        // Wait for countdown to finish
        await delay(8000);

        // Click for final link
        for (let i = 0; i < 6; i++) {
            if (capturedUrl) break;
            await page.evaluate(sel => {
                const btn = document.querySelector(sel);
                if (btn) btn.click();
            }, btnSelector);
            await delay(3500);
        }

        if (capturedUrl) return { success: true, url: capturedUrl };
        throw new Error("Could not capture link. Site protection might be too strong.");

    } catch (e) {
        return { success: false, error: e.message };
    } finally {
        if (browser) await browser.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WETAFILES / DOWNLOADWELLA — Snipe direct link via Puppeteer
// ─────────────────────────────────────────────────────────────────────────────
async function getUniversalDirectLink(targetUrl) {
    let browser;
    try {
        const isWella = targetUrl.includes('downloadwella.com');
        const siteDomain = isWella ? 'downloadwella.com' : 'wetafiles.com';

        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);

        let capturedUrl = null;

        page.on('request', request => {
            const url = request.url();
            if ((url.includes('dwbe') || url.includes('/dl/')) &&
                !url.includes('google-analytics') &&
                (url.includes('.mp4') || url.includes('.mkv') || url.includes('.zip'))) {
                capturedUrl = url;
            }
        });

        browser.on('targetcreated', async (target) => {
            const adPage = await target.page();
            if (adPage && !adPage.url().includes(siteDomain)) {
                await adPage.close().catch(() => {});
                await page.bringToFront();
            }
        });

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

        const firstBtn = '#downloadbtn';
        await page.waitForSelector(firstBtn, { timeout: 15000 });
        await page.click(firstBtn);
        await delay(5000);

        await page.evaluate(() => {
            const btn = document.querySelector('#downloadbtn') ||
                        document.querySelector('a.downloadbtn') ||
                        document.querySelector('#direct_link a');
            if (btn) btn.click();
        });

        await delay(3000);

        if (!capturedUrl) {
            capturedUrl = await page.evaluate(() => {
                const link = document.querySelector('a[href*="dwbe"]') ||
                             document.querySelector('#direct_link a');
                return link ? link.href : null;
            });
        }

        if (capturedUrl) return { success: true, creator: "ZANTA-MD", download_url: capturedUrl };
        throw new Error("Could not capture real direct link.");

    } catch (e) {
        return { success: false, error: e.message };
    } finally {
        if (browser) await browser.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CINESUBZ — Extract via Axios
// ─────────────────────────────────────────────────────────────────────────────
async function getCinesubzAxiosHTML(targetUrl) {
    try {
        const mainResponse = await cookieClient.get(targetUrl, { headers: SHARED_HEADERS });
        const $ = cheerio.load(mainResponse.data);

        let botSonicUrl = "";
        $('a').each((_, el) => {
            const href = $(el).attr('href');
            if (href && (href.includes('botsonic') || href.includes('sonic-cloud'))) {
                botSonicUrl = href;
            }
        });

        if (!botSonicUrl) {
            botSonicUrl = mainResponse.request?.res?.responseUrl || targetUrl;
        }

        const botResponse = await cookieClient.get(botSonicUrl, {
            headers: { ...SHARED_HEADERS, 'Referer': targetUrl }
        });

        return {
            success: true,
            finalUrl: botResponse.config.url,
            html: botResponse.data
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GDRIVE — Bypass download confirmation
// ─────────────────────────────────────────────────────────────────────────────
async function getGDriveDirectLink(driveUrl) {
    try {
        const response = await axios.get(driveUrl, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*' }
        });
        const html = response.data;

        const atMatch   = html.match(/name="at"\s+value="([^"]+)"/);
        const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/);
        const idMatch   = html.match(/name="id"\s+value="([^"]+)"/);

        if (atMatch?.[1]) {
            const atToken = atMatch[1];
            const uuid    = uuidMatch?.[1] || '';
            const fileId  = idMatch?.[1] || driveUrl.split('id=')[1]?.split('&')[0];
            return {
                success: true,
                download_url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t&uuid=${uuid}&at=${atToken}`
            };
        }
        return { success: false, error: "Security token not found. Google may be blocking the server IP." };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMEHEAVEN — Search / Episodes / Download via Puppeteer
// ─────────────────────────────────────────────────────────────────────────────
async function searchAnime(query) {
    try {
        const { data } = await axios.get(`${ANIME_BASE}/search.php?s=${encodeURIComponent(query)}`, { headers: getAnimeHeaders() });
        const $ = cheerio.load(data);
        let results = [];

        $('.similarimg').each((_, el) => {
            const anchor = $(el).find('a');
            const imgTag = anchor.find('img');
            const url    = anchor.attr('href');
            if (url) {
                results.push({
                    title: imgTag.attr('alt')?.trim() || "No Title",
                    url:   `${ANIME_BASE}/${url}`,
                    image: imgTag.attr('src') ? `${ANIME_BASE}/${imgTag.attr('src')}` : null
                });
            }
        });
        return { success: true, count: results.length, results };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getEpisodes(animeUrl) {
    try {
        const { data } = await axios.get(animeUrl, { headers: getAnimeHeaders() });
        const $ = cheerio.load(data);
        let episodes = [];

        $('.linetitle2 a').each((_, el) => {
            const epNumber = $(el).find('.watch2').text().trim();
            const dateAgo  = $(el).find('.watch1.bc.c').text().replace('Episode', '').trim();
            if (epNumber) episodes.push({ episode: epNumber, uploaded: dateAgo });
        });

        return {
            success: true,
            title:          $('.linetitle').first().text().trim() || $('h1').text().trim(),
            description:    $('.boldtext').first().text().trim(),
            total_episodes: episodes.length,
            episodes
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getDirectAnimeLink(animeUrl, episodeNum) {
    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);

        let capturedMp4 = null;
        await page.setRequestInterception(true);

        page.on('request', request => {
            const url = request.url();
            if (url.includes('video.mp4') || url.endsWith('.mp4')) capturedMp4 = url;
            if (url.includes('googleads') || url.includes('popads')) request.abort();
            else request.continue();
        });

        browser.on('targetcreated', async (target) => {
            const newPage = await target.page();
            if (newPage && !newPage.url().includes('animeheaven.me')) {
                await newPage.close().catch(() => {});
                await page.bringToFront();
            }
        });

        await page.goto(animeUrl, { waitUntil: 'domcontentloaded' });

        for (let i = 0; i < 5; i++) {
            if (capturedMp4) break;
            await page.evaluate(ep => {
                const anchors = Array.from(document.querySelectorAll('.linetitle2 a'));
                const target  = anchors.find(a => a.querySelector('.watch2')?.innerText.trim() === String(ep));
                if (target) target.click();
            }, episodeNum);
            await delay(4000);
        }

        if (capturedMp4) return { success: true, episode: episodeNum, download_url: capturedMp4 };
        throw new Error("Could not capture MP4 link.");
    } catch (e) {
        return { success: false, error: e.message };
    } finally {
        if (browser) await browser.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMEHEAVEN v2 (new API endpoints used by second API)
// ─────────────────────────────────────────────────────────────────────────────
async function searchAnimeV2(query) {
    try {
        const { data } = await axios.get(`${ANIME_BASE}/search.php?s=${encodeURIComponent(query)}`, { headers: getAnimeHeaders() });
        const $ = cheerio.load(data);
        const results = [];
        $('div.info3.bc1 > div.similarimg').each((_, element) => {
            const linkPath = $(element).find('div.p1 > a').attr('href');
            const imgPath  = $(element).find('img.coverimg').attr('src');
            if (linkPath) {
                results.push({
                    title: $(element).find('div.similarname.c > a').text().trim(),
                    image: imgPath ? `${ANIME_BASE}/${imgPath}` : null,
                    url:   `${ANIME_BASE}/${linkPath}`,
                    id:    linkPath.split('=')[1]
                });
            }
        });
        return { success: true, creator: "ZANTA-MD", count: results.length, data: results };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getAnimeInfo(url) {
    try {
        const { data } = await axios.get(url, { headers: getAnimeHeaders() });
        const $ = cheerio.load(data);
        const title       = $('div.infotitle.c').first().text().trim();
        const image       = $('img.posterimg').attr('src');
        const description = $('div.infodes.c').text().trim();
        const episodes    = [];

        $('div.linetitle2.c2 a.c').each((_, e) => {
            const epId  = $(e).attr('id');
            const epNum = $(e).find('div.watch2.bc').text().trim() || (episodes.length + 1);
            if (epId) episodes.push({ episode: epNum, url: `${ANIME_BASE}/gate.php?id=${epId}` });
        });

        return {
            success: true,
            creator: "ZANTA-MD",
            result: { title, image: image ? `${ANIME_BASE}/${image}` : null, description, episodes }
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getAnimeDownload(url) {
    try {
        const { data } = await axios.get(url, { headers: getAnimeHeaders() });
        const $ = cheerio.load(data);
        let dlLink = $('a[href*="video.mp4"]').attr('href');
        if (!dlLink) {
            const match = data.match(/https:\/\/c[a-z]{1,2}\.animeheaven\.me\/video\.mp4\?[^"']+/);
            if (match) dlLink = match[0];
        }
        if (!dlLink) dlLink = $('video source').attr('src');
        if (!dlLink) return { success: false, message: "Could not bypass. Site may be protected." };
        return { success: true, creator: "ZANTA-MD", download_url: dlLink };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CARTOONS.LK — Search & Download via Puppeteer
// ─────────────────────────────────────────────────────────────────────────────
async function searchCartoons(query) {
    try {
        const { data } = await axios.get(`https://cartoons.lk/?s=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': USER_AGENT }
        });
        const $ = cheerio.load(data);
        let results = [];
        $('article.item-list').each((_, el) => {
            const titleEl = $(el).find('h2.post-box-title a');
            const title   = titleEl.text().trim();
            const url     = titleEl.attr('href');
            const image   = $(el).find('div.post-thumbnail img').attr('src');
            const date    = $(el).find('span.post-meta span.date').text().trim();
            if (title && url) {
                results.push({
                    title: title.replace('Sinhala Dubbed | සිංහල හඬකැවූ', '').trim(),
                    url, image, date: date || "Unknown"
                });
            }
        });
        return { success: true, count: results.length, results };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getCartoonDownload(inputUrl) {
    let browser;
    try {
        let cartoonUrl = inputUrl;
        let epNum = null;

        if (inputUrl.includes(',')) {
            const parts = inputUrl.split(',');
            cartoonUrl = parts[0].trim();
            epNum = parseInt(parts[1].trim());
        }

        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);

        let capturedUrl = null;

        page.on('response', async response => {
            const url = response.url();
            if (url.includes('download-proxy')) {
                const status  = response.status();
                const headers = response.headers();
                if (status >= 300 && status <= 308 && headers['location']) {
                    capturedUrl = headers['location'];
                }
            }
            if (url.includes('.mp4') || url.includes('files.cartoons.lk')) capturedUrl = url;
        });

        browser.on('targetcreated', async target => {
            const adPage = await target.page();
            if (adPage && !adPage.url().includes('cartoons.lk')) {
                await adPage.close().catch(() => {});
            }
        });

        await page.goto(cartoonUrl, { waitUntil: 'networkidle2', timeout: 35000 });

        const isSeries = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button, span, .download-btn'))
                .find(el => el.innerText.toLowerCase().includes('select episode'));
            return !!btn;
        });

        if (isSeries && !epNum) {
            await page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button, .download-btn'))
                    .find(b => b.innerText.toLowerCase().includes('select episode'));
                if (btn) btn.click();
            });
            await page.waitForSelector('.episode-popup-item', { timeout: 15000 });
            const episodes = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.episode-popup-item')).map((item, index) => ({
                    episode_index: index + 1,
                    name: item.querySelector('h4')?.innerText.trim() || `Episode ${index + 1}`,
                    info: item.querySelector('.episode-popup-info')?.innerText.trim() || ""
                }));
            });
            return { success: true, type: 'series', results: episodes };
        }

        if (isSeries && epNum) {
            await page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button, .download-btn'))
                    .find(b => b.innerText.toLowerCase().includes('select episode'));
                if (btn) btn.click();
            });
            await page.waitForSelector('.episode-popup-item', { timeout: 15000 });
            const clicked = await page.evaluate(targetNo => {
                const items  = document.querySelectorAll('.episode-popup-item');
                const target = items[targetNo - 1]?.querySelector('button.episode-popup-btn');
                if (target) { target.click(); return true; }
                return false;
            }, epNum);
            if (!clicked) return { success: false, error: "Episode not found in popup." };
        } else {
            await page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button, .download-btn'))
                    .find(b => b.innerText.toLowerCase().includes('download') &&
                               !b.innerText.toLowerCase().includes('select'));
                if (btn) btn.click();
            });
        }

        for (let i = 0; i < 12; i++) {
            if (capturedUrl) break;
            await delay(2500);
            if (i % 3 === 0 && !capturedUrl) {
                await page.evaluate((isS, eN) => {
                    if (isS && eN) {
                        document.querySelectorAll('.episode-popup-item')[eN - 1]
                            ?.querySelector('button.episode-popup-btn')?.click();
                    } else {
                        Array.from(document.querySelectorAll('button, .download-btn'))
                            .find(b => b.innerText.toLowerCase().includes('download') &&
                                       !b.innerText.toLowerCase().includes('select'))?.click();
                    }
                }, isSeries, epNum);
            }
        }

        if (capturedUrl) return { success: true, type: 'direct', download_url: capturedUrl };
        return { success: false, error: "Link capture timed out." };

    } catch (e) {
        return { success: false, error: e.message };
    } finally {
        if (browser) await browser.close();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVIESUBLK — Search
// ─────────────────────────────────────────────────────────────────────────────
async function searchMoviesublk(query) {
    try {
        const response = await axios.get(`https://www.moviesublk.com/search?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.moviesublk.com/' }
        });
        const $ = cheerio.load(response.data);
        let results = [];

        $('.s-card').each((_, el) => {
            const title = $(el).find('.s-title').text().trim();
            const link  = $(el).attr('onclick')?.match(/'([^']+)'/)?.[1] || "";
            const img   = $(el).find('.s-thumb').attr('src');
            const type  = $(el).find('.s-badge').text().trim() || "MOVIE";
            if (title && link) results.push({ title, url: link, thumbnail: img, type });
        });

        if (results.length === 0) {
            $('.post-outer, article').each((_, el) => {
                const title = $(el).find('.entry-title a, .post-title a').text().trim();
                const link  = $(el).find('.entry-title a, .post-title a').attr('href');
                const img   = $(el).find('img').attr('src');
                if (title && link) results.push({ title, url: link, thumbnail: img, type: "MOVIE" });
            });
        }

        return { status: true, creator: "ZANTA-MD", count: results.length, results };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVIESUBLK — Movie download
// ─────────────────────────────────────────────────────────────────────────────
async function getMoviesublkDL(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.moviesublk.com/' }
        });
        const html = response.data;
        const $    = cheerio.load(html);
        const title = $('title').text().replace(' - MovieSubLK', '').trim();
        const image = $('.post-body.entry-content img').first().attr('src') || "";

        const movieDetails = {};
        $('.post-body.entry-content ul li').each((_, el) => {
            const text = $(el).text();
            if (text.includes(':')) {
                const parts = text.split(':');
                const key   = parts[0].trim();
                const value = parts[1].trim();
                if (key && value) movieDetails[key] = value;
            }
        });
        if (Object.keys(movieDetails).length === 0) {
            $('.sd-info strong').each((_, el) => {
                const key   = $(el).text().replace(':', '').trim();
                const value = el.nextSibling ? $(el.nextSibling).text().trim() : "";
                if (key && value) movieDetails[key] = value;
            });
        }

        const gdriveRegex = /https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([a-zA-Z0-9_-]+)/;
        const match       = html.match(gdriveRegex);
        if (!match?.[1]) return { status: false, message: "Google Drive ID not found." };

        const fileId    = match[1];
        let finalLink   = `https://drive.google.com/uc?export=download&id=${fileId}`;

        try {
            const gRes         = await axios.get(finalLink, { timeout: 10000 });
            const confirmMatch = gRes.data.match(/confirm=([a-zA-Z0-9_]+)/);
            if (confirmMatch) finalLink = `https://drive.google.com/uc?export=download&confirm=${confirmMatch[1]}&id=${fileId}`;
        } catch (e) {}

        return {
            status: true, creator: "ZANTA-MD", title, image, movie_info: movieDetails,
            file_id: fileId,
            gdrive_url: `https://drive.google.com/file/d/${fileId}/view`,
            direct_download_url: finalLink
        };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVIESUBLK — TV Show download
// ─────────────────────────────────────────────────────────────────────────────
async function getTVShowDL(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.moviesublk.com/' }
        });
        const html = response.data;
        const $    = cheerio.load(html);
        const title = $('title').text().replace(' - MovieSubLK', '').trim();
        const image = $('.post-body.entry-content img').first().attr('src') || "";

        const epGrid = $('#ep-grid, .nav-grid');
        if (epGrid.length > 0) {
            let episodes = [];
            epGrid.find('button, a').each((_, el) => {
                const epTitle = $(el).text().trim();
                const epLink  = $(el).attr('href') || $(el).attr('onclick')?.match(/'([^']+)'/)?.[1] || "";
                if (epTitle) {
                    episodes.push({
                        episode: epTitle,
                        url: epLink.startsWith('http') ? epLink : `https://www.moviesublk.com${epLink}`
                    });
                }
            });
            return { status: true, type: "TV_SHOW", creator: "ZANTA-MD", title, image, total_episodes: episodes.length, episodes };
        }

        // Fallback: treat as movie
        const movieDetails = {};
        $('.post-body.entry-content ul li').each((_, el) => {
            const text = $(el).text();
            if (text.includes(':')) {
                const parts = text.split(':');
                movieDetails[parts[0].trim()] = parts[1].trim();
            }
        });

        const gdriveRegex = /https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([a-zA-Z0-9_-]+)/;
        const match       = html.match(gdriveRegex);
        if (!match?.[1]) return { status: true, type: "MOVIE", title, message: "Direct link not found." };

        const fileId = match[1];
        return {
            status: true, type: "MOVIE", creator: "ZANTA-MD", title, image,
            movie_info: movieDetails,
            direct_download_url: `https://drive.google.com/uc?export=download&id=${fileId}`
        };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PAST PAPERS — Search & Download
// ─────────────────────────────────────────────────────────────────────────────
async function searchPastPapers(query) {
    try {
        const response = await axios.get(`https://pastpapers.wiki/?s=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': USER_AGENT }
        });
        const $ = cheerio.load(response.data);
        let results = [];
        $('.jeg_posts article.jeg_post').each((_, el) => {
            const title   = $(el).find('.jeg_post_title a').text().trim();
            const link    = $(el).find('.jeg_post_title a').attr('href');
            const img     = $(el).find('.thumbnail-container img').attr('src');
            const excerpt = $(el).find('.jeg_post_excerpt p').text().trim();
            if (title && link) results.push({ title, url: link, thumbnail: img, description: excerpt });
        });
        return { success: true, creator: "ZANTA-MD", count: results.length, results };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getPastPaperDL(url) {
    try {
        const response = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
        const $     = cheerio.load(response.data);
        const title = $('.entry-header h1').text().trim() || $('title').text().trim();

        let downloadLink = $('.wpfd-downloadlink').attr('href') ||
                           $('.wpfd-single-file-button').attr('href');

        if (!downloadLink) {
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                if (href && href.includes('/download/')) downloadLink = href;
            });
        }

        if (downloadLink) {
            return { success: true, creator: "ZANTA-MD", title, download_url: downloadLink };
        }
        return { success: false, message: "Download link not found." };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AN1.COM — Search & Download APK
// ─────────────────────────────────────────────────────────────────────────────
async function searchAN1(query) {
    try {
        const response = await axios.get(
            `https://an1.com/?story=${encodeURIComponent(query)}&do=search&subaction=search`,
            { headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://an1.com/' } }
        );
        const $ = cheerio.load(response.data);
        let results = [];
        $('.app_list .item').each((_, el) => {
            const title     = $(el).find('.cont .data .name span').text().trim();
            const link      = $(el).find('.cont .data .name a').attr('href');
            const img       = $(el).find('.img img').attr('src') || "";
            const developer = $(el).find('.developer').text().trim();
            const rating    = $(el).find('.meta .rating_num').text().trim() || "N/A";
            if (link && title) {
                results.push({
                    title, url: link,
                    thumbnail: img.startsWith('http') ? img : `https://an1.com${img}`,
                    developer, rating
                });
            }
        });
        return { success: true, creator: "ZANTA-MD", count: results.length, results };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getAN1Download(url) {
    try {
        const H = { 'User-Agent': USER_AGENT, 'Referer': 'https://an1.com/' };
        const mainPage = await axios.get(url, { headers: H });
        const $main    = cheerio.load(mainPage.data);

        const title      = $main('h1').first().text().trim();
        const imgSrc     = $main('.app_view_first img').attr('src') || $main('img[itemprop="image"]').attr('src') || "";
        const imageUrl   = imgSrc.startsWith('http') ? imgSrc : `https://an1.com${imgSrc}`;
        const fileSize   = $main('span[itemprop="fileSize"]').text().trim() || "N/A";

        let androidVersion = "N/A";
        $main('ul.spec li').each((_, el) => {
            const text = $main(el).text();
            if (text.includes('Android')) androidVersion = text.replace('Android', '').trim();
        });

        let dwPath = $main('.spec_addon a.btn-green').attr('href') || $main('.download_line').attr('href');
        if (!dwPath) dwPath = url.replace('.html', '-dw.html').replace('https://an1.com', '');

        const downloadPageUrl = dwPath.startsWith('http') ? dwPath : `https://an1.com${dwPath}`;
        const downloadPage    = await axios.get(downloadPageUrl, { headers: { ...H, 'Referer': url } });
        const $dw             = cheerio.load(downloadPage.data);
        let finalLink         = $dw('a#pre_download').attr('href');

        if (!finalLink) {
            const matches = downloadPage.data.match(/https:\/\/files\.an1\.net\/[^"'\s<>]+/g);
            if (matches) finalLink = matches.find(l => !l.includes('an1store.apk'));
        }

        if (finalLink) {
            return {
                success: true, creator: "ZANTA-MD",
                info: { title, android: androidVersion, size: fileSize, thumbnail: imageUrl },
                download_url: finalLink
            };
        }
        return { success: false, message: "Link not found." };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINHALASUB — Search & Movie details
// ─────────────────────────────────────────────────────────────────────────────
async function searchSinhalasub(query) {
    try {
        const response = await axios.get(
            `https://sinhalasub.lk/?s=${encodeURIComponent(query)}`,
            { headers: SINHALASUB_HEADERS, timeout: 15000 }
        );
        const $ = cheerio.load(response.data);
        let results = [];
        $('.display-item, .result-item, article').each((_, el) => {
            const a     = $(el).find('.item-box a, h2 a, h3 a, .title a').first();
            const title = a.attr('title') || a.text().trim();
            const link  = a.attr('href');
            const img   = $(el).find('img').attr('src');
            if (link && title && link.includes('sinhalasub.lk')) {
                results.push({
                    title: title.replace('Sinhala Subtitles | සිංහල උපසිරැසි සමඟ', '').trim(),
                    url: link, image: img
                });
            }
        });
        return { status: true, results };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

async function getSinhalasubDetails(url) {
    try {
        const response = await axios.get(url, { headers: SINHALASUB_HEADERS, timeout: 15000 });
        const $ = cheerio.load(response.data);

        const title  = $('.data h1').text().trim() || $('.entry-title').text().trim();
        const poster = $('.poster img').attr('src') || $('meta[property="og:image"]').attr('content');
        const rating = $('.details .imdb b').text().trim() || "N/A";

        let tempLinks = [];
        $('table tr').each((_, el) => {
            const linkTag = $(el).find('a[href*="/links/"]');
            if (linkTag.length > 0) {
                tempLinks.push({
                    quality:     $(el).find('td').first().text().trim(),
                    size:        $(el).find('td:nth-child(2)').text().trim(),
                    redirectUrl: linkTag.attr('href')
                });
            }
        });

        const finalDownloads = await Promise.all(tempLinks.map(async item => {
            try {
                const resLink         = await axios.get(item.redirectUrl, { headers: { ...SINHALASUB_HEADERS, 'Referer': url }, timeout: 8000 });
                const pixeldrainMatch = resLink.data.match(/https?:\/\/pixeldrain\.com\/u\/([a-zA-Z0-9]+)/);
                if (pixeldrainMatch) {
                    return {
                        quality:    `${item.quality} (${item.size})`,
                        direct_url: `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}?download=1`
                    };
                }
                return null;
            } catch (e) { return null; }
        }));

        return {
            status: true,
            title:          title.replace('Sinhala Subtitles | සිංහල උපසිරැසි සමඟ', '').trim(),
            rating, poster,
            download_links: finalDownloads.filter(l => l !== null)
        };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// THENKIRI — Search & Download
// ─────────────────────────────────────────────────────────────────────────────
async function searchThenkiri(text) {
    try {
        const { data } = await axios.get(
            `https://thenkiri.com/?s=${encodeURIComponent(text)}&post_type=post`,
            { headers: { 'User-Agent': USER_AGENT } }
        );
        const $ = cheerio.load(data);
        let results = [];
        $('article').slice(0, 10).each((i, el) => {
            const title = $(el).find('.entry-title a').text().trim();
            const link  = $(el).find('.entry-title a').attr('href');
            const img   = $(el).find('img').attr('src');
            if (link) results.push({ index: i + 1, title, url: link, thumbnail: img });
        });
        return { status: true, results };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

async function getThenkiriDL(url) {
    try {
        const response  = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
        const $         = cheerio.load(response.data);
        const title     = $('h1.entry-title').text().trim();
        const thumbnail = ($('meta[property="og:image"]').attr('content') || "").trim();

        const rawLinks = [];
        $('a[href*="downloadwella.com"]').each((_, el) => {
            rawLinks.push({ quality: $(el).text().trim(), link: $(el).attr('href') });
        });

        let dlLinks = [];
        for (let item of rawLinks) {
            try {
                const pageRes  = await axios.get(item.link, { headers: { 'User-Agent': USER_AGENT } });
                const $dlPage  = cheerio.load(pageRes.data);
                const formData = new URLSearchParams();
                $dlPage('form input').each((_, input) => {
                    const name  = $dlPage(input).attr('name');
                    const value = $dlPage(input).attr('value');
                    if (name) formData.append(name, value || '');
                });
                const postRes = await axios.post(item.link, formData.toString(), {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent':   USER_AGENT,
                        'Referer':      item.link,
                        'Cookie': pageRes.headers['set-cookie']?.join('; ') || ''
                    }
                });
                const $final     = cheerio.load(postRes.data);
                const directLink = $final('a[href*="downloadwella.com/d/"]').attr('href');
                dlLinks.push({ quality: item.quality, direct_link: directLink || item.link });
            } catch (e) {
                dlLinks.push({ quality: item.quality, direct_link: item.link });
            }
        }
        return { status: true, title, thumbnail, links: dlLinks };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTAGRAM — Download
// ─────────────────────────────────────────────────────────────────────────────
async function getInstagramMedia(url) {
    try {
        const response = await axios({
            method: 'post',
            url: 'https://api.instasave.website/media',
            data: new URLSearchParams({ url }).toString(),
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'origin':       'https://instasave.website',
                'referer':      'https://instasave.website/',
                'user-agent':   USER_AGENT
            }
        });
        const tokenRegex  = /https:\/\/cdn\.instasave\.website\/\?token=[a-zA-Z0-9._-]+/g;
        const matches     = response.data.match(tokenRegex);
        if (matches?.length >= 2) {
            const uniqueLinks = [...new Set(matches)];
            return { status: true, thumbnail: uniqueLinks[0], downloadUrl: uniqueLinks[uniqueLinks.length - 1] };
        }
        return { status: false, message: "Media not found." };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEEPAI — Chat
// ─────────────────────────────────────────────────────────────────────────────
async function deepChat(text) {
    try {
        const params = new URLSearchParams();
        params.append('chat_style',   'chat');
        params.append('chatHistory',  JSON.stringify([{ role: 'user', content: text }]));
        params.append('model',        'standard');
        params.append('session_uuid', '5857c2d1-e5b9-4165-beb6-a242e354788c');
        params.append('hacker_is_stinky', 'very_stinky');

        const response = await axios({
            method: 'POST',
            url: 'https://api.deepai.org/hacking_is_a_serious_crime',
            headers: {
                'api-key':          'tryit-77318428809-3d7b57af319cc19387a77a13885d6851',
                'User-Agent':       USER_AGENT,
                'Referer':          'https://deepai.org/chat',
                'Origin':           'https://deepai.org',
                'Content-Type':     'application/x-www-form-urlencoded',
                'x-requested-with': 'XMLHttpRequest'
            },
            data: params.toString()
        });
        return { status: true, prompt: text, result: response.data };
    } catch (e) {
        return { status: false, error: "AI Chat failed", details: e.response?.data || e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// YOUTUBE — Search & MP3 Download
// ─────────────────────────────────────────────────────────────────────────────
async function ytSearch(query) {
    try {
        const search  = await yts(query);
        const results = search.videos.slice(0, 10).map(v => ({
            title:     v.title,
            url:       v.url,
            thumbnail: v.thumbnail,
            timestamp: v.timestamp,
            author:    v.author.name
        }));
        return { status: true, results };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

async function ytDownload(youtubeUrl) {
    try {
        const videoId = youtubeUrl.split('be/')[1]?.split('?')[0] ||
                        youtubeUrl.split('v=')[1]?.split('&')[0];
        if (!videoId) return { status: false, error: "Invalid YouTube URL" };

        const ajaxUrl = 'https://ssyoutube.online/wp-admin/admin-ajax.php';
        const res1    = await axios.post(ajaxUrl, new URLSearchParams({ action: 'get_mp3_yt_option', videoId }));

        if (!res1.data?.success || !res1.data.data.link)
            return { status: false, error: "Download link not found" };

        const res2 = await axios.post(ajaxUrl, new URLSearchParams({
            action: 'mp3_yt_generic_proxy_ajax', targetUrl: res1.data.data.link
        }));

        if (res2.data?.success && res2.data.data.proxiedUrl) {
            return { status: true, title: res1.data.data.title, download_url: res2.data.data.proxiedUrl };
        }
        return { status: false, error: "Proxy generation failed" };
    } catch (e) {
        return { status: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// KISSKH — Search & Download
// ─────────────────────────────────────────────────────────────────────────────
async function kisskhSearch(query, type = 0) {
    try {
        const response = await kisskhClient.get(`${KISSKH_API}/DramaList/Search`, {
            params: { q: query, type },
            headers: {
                'User-Agent': USER_AGENT,
                'Accept':     'application/json, text/plain, */*',
                'Referer':    'https://kisskh.do/',
                'Origin':     'https://kisskh.do'
            }
        });
        const data = response.data;
        let results = [];
        if (Array.isArray(data)) {
            results = data.map(item => ({
                id:       item.id,
                title:    item.title || item.name,
                poster:   item.poster || item.image,
                year:     item.year,
                country:  item.country,
                type:     item.type,
                episodes: item.episodes || item.totalEpisodes
            }));
        } else if (data.data)    results = data.data;
        else if (data.items)     results = data.items;
        else if (data.results)   results = data.results;

        return { success: true, creator: "ZANTA-MD", query, count: results.length, results };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function kisskhDownload(url) {
    try {
        const response = await kisskhClient.get(url, {
            headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://kisskh.do/' }
        });
        const $ = cheerio.load(response.data);
        let downloadLinks = [];

        $('.server-btn, .download-btn, a[href*="download"], a[href*="m3u8"], a[href*="mp4"]').each((i, el) => {
            const link   = $(el).attr('href');
            const server = $(el).text().trim() || `Server ${i + 1}`;
            if (link && (link.startsWith('http') || link.startsWith('/'))) {
                downloadLinks.push({ server, url: link.startsWith('/') ? `${KISSKH_BASE}${link}` : link });
            }
        });
        $('iframe').each((i, el) => {
            const src = $(el).attr('src');
            if (src) downloadLinks.push({ server: `Embed ${i + 1}`, url: src });
        });

        return { success: true, creator: "ZANTA-MD", downloadLinks, count: downloadLinks.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── FitGirl ──
app.get('/api/search',    async (req, res) => res.json(await searchGames(req.query.q)));
app.get('/api/files',     async (req, res) => res.json(await getGameFiles(req.query.url)));
app.get('/api/datanodes', async (req, res) => res.json(await getDirectDownload(req.query.url)));

// ── Weta / Wella ──
app.get('/api/weta/dl', async (req, res) => {
    if (!req.query.url) return res.json({ success: false, error: "URL required" });
    res.json(await getUniversalDirectLink(req.query.url));
});

// ── Cinesubz ──
app.get('/api/cinesubz/extract-axios', async (req, res) => {
    if (!req.query.url) return res.json({ success: false, error: "URL required" });
    res.json(await getCinesubzAxiosHTML(req.query.url));
});

// ── Google Drive ──
app.get('/api/gdrive/bypass', async (req, res) => {
    if (!req.query.url) return res.json({ success: false, error: "Drive URL required" });
    res.json(await getGDriveDirectLink(req.query.url));
});

// ── Anime (old endpoints) ──
app.get('/api/anime/search',   async (req, res) => res.json(await searchAnime(req.query.q)));
app.get('/api/anime/episodes', async (req, res) => res.json(await getEpisodes(req.query.url)));
app.get('/api/anime/download', async (req, res) => res.json(await getDirectAnimeLink(req.query.url, req.query.ep)));

// ── Anime (new endpoints) ──
app.get('/api/anime-search',   async (req, res) => res.json(await searchAnimeV2(req.query.q)));
app.get('/api/anime-info',     async (req, res) => res.json(await getAnimeInfo(req.query.url)));
app.get('/api/anime-download', async (req, res) => res.json(await getAnimeDownload(req.query.url)));

// ── Cartoons ──
app.get('/api/cartoons/search',   async (req, res) => res.json(await searchCartoons(req.query.q)));
app.get('/api/cartoons/download', async (req, res) => res.json(await getCartoonDownload(req.query.url)));

// ── MovieSubLK ──
app.get('/api/moviesublk/search', async (req, res) => {
    if (!req.query.q) return res.json({ status: false, message: "Query required" });
    res.json(await searchMoviesublk(req.query.q));
});
app.get('/api/moviesublk/dl', async (req, res) => {
    if (!req.query.url) return res.json({ status: false, message: "URL required" });
    res.json(await getMoviesublkDL(req.query.url));
});
app.get('/api/tvshow/dl', async (req, res) => {
    if (!req.query.url) return res.json({ status: false, message: "URL required" });
    res.json(await getTVShowDL(req.query.url));
});

// ── Past Papers ──
app.get('/api/pastpaper/search', async (req, res) => {
    if (!req.query.q) return res.json({ success: false, message: "Query required" });
    res.json(await searchPastPapers(req.query.q));
});
app.get('/api/pastpaper/dl', async (req, res) => {
    if (!req.query.url) return res.json({ success: false, message: "URL required" });
    res.json(await getPastPaperDL(req.query.url));
});

// ── AN1 APK ──
app.get('/api/an1/search',   async (req, res) => {
    if (!req.query.q) return res.json({ success: false, message: "Query required" });
    res.json(await searchAN1(req.query.q));
});
app.get('/api/an1/download', async (req, res) => {
    if (!req.query.url) return res.json({ success: false, message: "URL required" });
    res.json(await getAN1Download(req.query.url));
});

// ── SinhalaSub ──
app.get('/api/sinhalasub/search',        async (req, res) => {
    if (!req.query.q) return res.json({ status: false, message: "Query required" });
    res.json(await searchSinhalasub(req.query.q));
});
app.get('/api/sinhalasub/movie-details', async (req, res) => {
    if (!req.query.url) return res.json({ status: false, message: "URL required" });
    res.json(await getSinhalasubDetails(req.query.url));
});

// ── Thenkiri ──
app.get('/api/thenkiri/search', async (req, res) => {
    if (!req.query.text) return res.json({ status: false, message: "Query required" });
    res.json(await searchThenkiri(req.query.text));
});
app.get('/api/thenkiri', async (req, res) => {
    if (!req.query.url) return res.json({ status: false, message: "URL required" });
    res.json(await getThenkiriDL(req.query.url));
});

// ── Instagram ──
app.get('/api/insta', async (req, res) => {
    if (!req.query.url) return res.json({ status: false, message: "URL required" });
    res.json(await getInstagramMedia(req.query.url));
});

// ── DeepAI Chat ──
app.get('/api/deepchat', async (req, res) => {
    if (!req.query.text) return res.json({ status: false, message: "Text required" });
    res.json(await deepChat(req.query.text));
});

// ── YouTube ──
app.get('/api/yt/search', async (req, res) => {
    if (!req.query.q) return res.json({ status: false, error: "Query required" });
    res.json(await ytSearch(req.query.q));
});
app.get('/api/download', async (req, res) => {
    if (!req.query.url) return res.json({ status: false, error: "URL required" });
    res.json(await ytDownload(req.query.url));
});

// ── KissKH ──
app.get('/api/kisskh/search', async (req, res) => {
    if (!req.query.q) return res.json({ success: false, message: "Query required" });
    res.json(await kisskhSearch(req.query.q, req.query.type || 0));
});
app.get('/api/kisskh/download', async (req, res) => {
    if (!req.query.url) return res.json({ success: false, message: "URL required" });
    res.json(await kisskhDownload(req.query.url));
});

// ── Health check ──
app.get('/', (req, res) => res.json({ status: true, message: "ZANTA-MD API Online ✅", creator: "ZANTA-MD" }));

// ═════════════════════════════════════════════════════════════════════════════
// SERVER START
// ═════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🚀 ZANTA-MD API running on port ${PORT}`));
server.timeout = 180000; // 3 min timeout for Puppeteer-heavy routes

module.exports = app;