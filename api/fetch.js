const axios = require('axios');
const cheerio = require('cheerio');

// Main handler
export default async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
    
    // Handle OPTIONS
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            error: 'Method not allowed'
        });
    }

    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL is required'
            });
        }

        console.log('Processing URL:', url);

        // Validate URL
        try {
            new URL(url);
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Invalid URL format'
            });
        }

        // Check if it's already a Pixeldrain URL
        if (url.includes('pixeldrain.com') || url.includes('pixeldrain.dev')) {
            const pixeldrainId = extractPixeldrainId(url);
            if (pixeldrainId) {
                return res.status(200).json({
                    success: true,
                    isPack: false,
                    original: url,
                    pixeldrain_api: `https://pixeldrain.com/api/file/${pixeldrainId}`,
                    filename: null
                });
            }
        }

        // Fetch the page
        const html = await fetchPage(url);

        if (!html) {
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch page content'
            });
        }

        // Extract Pixeldrain links
        const links = extractAllPixeldrainLinks(html);

        if (links.length === 0) {
            // Try to find iframes or redirects
            const $ = cheerio.load(html);
            
            // Check for iframes
            const iframeSrc = $('iframe').attr('src');
            if (iframeSrc && (iframeSrc.includes('pixeldrain') || iframeSrc.includes('gdflix') || iframeSrc.includes('hubcloud'))) {
                const iframeHtml = await fetchPage(iframeSrc);
                if (iframeHtml) {
                    const iframeLinks = extractAllPixeldrainLinks(iframeHtml);
                    if (iframeLinks.length > 0) {
                        return sendResponse(res, url, iframeLinks);
                    }
                }
            }

            // Check for meta refresh or JavaScript redirects
            const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
            if (metaRefresh) {
                const urlMatch = metaRefresh.match(/url=(.+)/i);
                if (urlMatch) {
                    const redirectUrl = urlMatch[1];
                    const redirectHtml = await fetchPage(redirectUrl);
                    if (redirectHtml) {
                        const redirectLinks = extractAllPixeldrainLinks(redirectHtml);
                        if (redirectLinks.length > 0) {
                            return sendResponse(res, url, redirectLinks);
                        }
                    }
                }
            }

            return res.status(404).json({
                success: false,
                error: 'No Pixeldrain links found. The page might be protected or use dynamic loading.'
            });
        }

        return sendResponse(res, url, links);

    } catch (error) {
        console.error('Handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

// Send formatted response
function sendResponse(res, originalUrl, links) {
    if (links.length > 1) {
        return res.status(200).json({
            success: true,
            isPack: true,
            count: links.length,
            items: links.map((link, idx) => ({
                original: originalUrl,
                pixeldrain_api: link.apiUrl,
                filename: link.filename || `File ${idx + 1}`
            }))
        });
    }

    const link = links[0];
    return res.status(200).json({
        success: true,
        isPack: false,
        original: originalUrl,
        pixeldrain_api: link.apiUrl,
        filename: link.filename || null
    });
}

// Fetch page with retries
async function fetchPage(url, maxRetries = 3) {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios({
                method: 'GET',
                url: url,
                timeout: 15000,
                maxRedirects: 10,
                headers: {
                    'User-Agent': userAgents[i % userAgents.length],
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                validateStatus: () => true // Accept all status codes
            });

            if (response.status === 200 && response.data) {
                return response.data;
            }

            console.log(`Attempt ${i + 1} failed with status ${response.status}`);
            
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        } catch (error) {
            console.log(`Attempt ${i + 1} error:`, error.message);
            if (i === maxRetries - 1) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }

    return null;
}

// Extract Pixeldrain ID from URL
function extractPixeldrainId(url) {
    const patterns = [
        /pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/,
        /pixeldrain\.dev\/u\/([a-zA-Z0-9_-]+)/,
        /pixeldrain\.com\/api\/file\/([a-zA-Z0-9_-]+)/,
        /pixeldrain\.dev\/api\/file\/([a-zA-Z0-9_-]+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }

    return null;
}

// Extract all Pixeldrain links from HTML
function extractAllPixeldrainLinks(html) {
    const links = [];
    const seen = new Set();
    const $ = cheerio.load(html);

    // Pattern 1: Direct URLs in HTML
    const patterns = [
        /https?:\/\/pixeldrain\.com\/u\/([a-zA-Z0-9_-]{6,})/gi,
        /https?:\/\/pixeldrain\.dev\/u\/([a-zA-Z0-9_-]{6,})/gi,
        /pixeldrain\.com\/u\/([a-zA-Z0-9_-]{6,})/gi,
        /pixeldrain\.dev\/u\/([a-zA-Z0-9_-]{6,})/gi
    ];

    const htmlStr = typeof html === 'string' ? html : html.toString();

    patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(htmlStr)) !== null) {
            const id = match[1];
            if (id && !seen.has(id)) {
                seen.add(id);
                links.push({
                    id: id,
                    apiUrl: `https://pixeldrain.com/api/file/${id}`,
                    filename: extractFilenameFromContext(htmlStr, match.index)
                });
            }
        }
    });

    // Pattern 2: Using Cheerio for structured data
    $('a[href*="pixeldrain"]').each((i, elem) => {
        const href = $(elem).attr('href');
        const id = extractPixeldrainId(href);
        if (id && !seen.has(id)) {
            seen.add(id);
            links.push({
                id: id,
                apiUrl: `https://pixeldrain.com/api/file/${id}`,
                filename: $(elem).text().trim() || null
            });
        }
    });

    // Pattern 3: Check data attributes
    $('[data-url*="pixeldrain"], [data-href*="pixeldrain"]').each((i, elem) => {
        const dataUrl = $(elem).attr('data-url') || $(elem).attr('data-href');
        const id = extractPixeldrainId(dataUrl);
        if (id && !seen.has(id)) {
            seen.add(id);
            links.push({
                id: id,
                apiUrl: `https://pixeldrain.com/api/file/${id}`,
                filename: $(elem).text().trim() || $(elem).attr('title') || null
            });
        }
    });

    return links;
}

// Extract filename from surrounding context
function extractFilenameFromContext(html, position) {
    const start = Math.max(0, position - 500);
    const end = Math.min(html.length, position + 500);
    const context = html.substring(start, end);

    const patterns = [
        /title=["']([^"']+)["']/i,
        /data-title=["']([^"']+)["']/i,
        /data-name=["']([^"']+)["']/i,
        />([^<]+\.(mkv|mp4|avi|mov|webm|flv|m4v|zip|rar|pdf))</i,
        /download=["']([^"']+)["']/i
    ];

    for (const pattern of patterns) {
        const match = context.match(pattern);
        if (match && match[1] && match[1].length > 3 && match[1].length < 200) {
            const filename = match[1].trim();
            const blacklist = ['pixeldrain', 'download', 'click', 'here', 'button'];
            if (!blacklist.some(word => filename.toLowerCase().includes(word))) {
                return filename;
            }
        }
    }

    return null;
}
