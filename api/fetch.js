const axios = require('axios');
const cheerio = require('cheerio');

export default async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            error: 'Method not allowed'
        });
    }

    try {
        const { url, fetchInfo = true } = req.body;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL is required'
            });
        }

        console.log('Processing URL:', url);

        // Validate URL
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Invalid URL format'
            });
        }

        const hostname = parsedUrl.hostname.toLowerCase();

        // Check if it's already a Pixeldrain URL
        if (hostname.includes('pixeldrain')) {
            const pixeldrainId = extractPixeldrainId(url);
            if (pixeldrainId) {
                const info = fetchInfo ? await getPixeldrainInfo(pixeldrainId) : null;
                return res.status(200).json({
                    success: true,
                    isPack: false,
                    original: url,
                    pixeldrain_api: `https://pixeldrain.com/api/file/${pixeldrainId}`,
                    pixeldrain_id: pixeldrainId,
                    filename: info?.name || null,
                    filesize: info?.size || null,
                    thumbnail: info?.thumbnail_href ? `https://pixeldrain.com${info.thumbnail_href}` : null,
                    mime_type: info?.mime_type || null
                });
            }
        }

        // Detect site type and handle accordingly
        const siteType = detectSiteType(hostname, parsedUrl.pathname);
        console.log('Detected site type:', siteType);

        let links = [];

        switch (siteType) {
            case 'gdflix-pack':
            case 'gdrex-pack':
                links = await handlePackPage(url);
                break;
            case 'gdflix-file':
            case 'gdrex-file':
            case 'hubcloud':
            case 'gkyfilehost':
                links = await handleSinglePage(url);
                break;
            default:
                links = await handleGenericPage(url);
        }

        if (links.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No Pixeldrain links found on this page'
            });
        }

        // Fetch Pixeldrain info for all links
        if (fetchInfo) {
            const linksWithInfo = await Promise.all(
                links.map(async (link) => {
                    const info = await getPixeldrainInfo(link.id);
                    return {
                        ...link,
                        filename: info?.name || link.filename || `File_${link.id}`,
                        filesize: info?.size || null,
                        thumbnail: info?.thumbnail_href ? `https://pixeldrain.com${info.thumbnail_href}` : null,
                        mime_type: info?.mime_type || null
                    };
                })
            );
            links = linksWithInfo;
        }

        // Return response
        if (links.length > 1) {
            return res.status(200).json({
                success: true,
                isPack: true,
                count: links.length,
                items: links.map(link => ({
                    original: url,
                    pixeldrain_api: link.apiUrl,
                    pixeldrain_id: link.id,
                    filename: link.filename,
                    filesize: link.filesize,
                    thumbnail: link.thumbnail,
                    mime_type: link.mime_type
                }))
            });
        }

        const link = links[0];
        return res.status(200).json({
            success: true,
            isPack: false,
            original: url,
            pixeldrain_api: link.apiUrl,
            pixeldrain_id: link.id,
            filename: link.filename,
            filesize: link.filesize,
            thumbnail: link.thumbnail,
            mime_type: link.mime_type
        });

    } catch (error) {
        console.error('Handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

// Detect site type
function detectSiteType(hostname, pathname) {
    if (hostname.includes('gdflix') || hostname.includes('gdrex')) {
        if (pathname.includes('/pack/')) return hostname.includes('gdflix') ? 'gdflix-pack' : 'gdrex-pack';
        if (pathname.includes('/file/')) return hostname.includes('gdflix') ? 'gdflix-file' : 'gdrex-file';
    }
    if (hostname.includes('hubcloud')) return 'hubcloud';
    if (hostname.includes('gkyfilehost')) return 'gkyfilehost';
    return 'generic';
}

// Handle pack pages (gdflix/gdrex)
async function handlePackPage(url) {
    console.log('Handling pack page:', url);
    const links = [];
    const seen = new Set();

    // Fetch main pack page
    const html = await fetchPage(url);
    if (!html) return [];

    const $ = cheerio.load(html);

    // Method 1: Find all file links in the pack
    const fileLinks = [];
    
    // Look for links in various formats
    $('a[href*="/file/"], a[href*="pixeldrain"]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href) {
            // Check if it's a pixeldrain link directly
            const pixelId = extractPixeldrainId(href);
            if (pixelId && !seen.has(pixelId)) {
                seen.add(pixelId);
                const filename = $(elem).text().trim() || $(elem).attr('title') || null;
                links.push({
                    id: pixelId,
                    apiUrl: `https://pixeldrain.com/api/file/${pixelId}`,
                    filename: filename
                });
            } else if (href.includes('/file/') && !href.includes('pixeldrain')) {
                // It's a site file link, collect for fetching
                const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
                if (!fileLinks.includes(fullUrl)) {
                    fileLinks.push({
                        url: fullUrl,
                        name: $(elem).text().trim() || null
                    });
                }
            }
        }
    });

    // Method 2: Look for table rows or list items with file info
    $('tr, .file-item, .pack-item, li').each((i, elem) => {
        const $elem = $(elem);
        const link = $elem.find('a[href*="/file/"], a[href*="pixeldrain"]').first();
        if (link.length) {
            const href = link.attr('href');
            const pixelId = extractPixeldrainId(href);
            if (pixelId && !seen.has(pixelId)) {
                seen.add(pixelId);
                const filename = $elem.find('.file-name, .name, td:first-child').text().trim() || 
                                link.text().trim() || null;
                links.push({
                    id: pixelId,
                    apiUrl: `https://pixeldrain.com/api/file/${pixelId}`,
                    filename: filename
                });
            } else if (href && href.includes('/file/') && !href.includes('pixeldrain')) {
                const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
                const existingIdx = fileLinks.findIndex(f => f.url === fullUrl);
                if (existingIdx === -1) {
                    fileLinks.push({
                        url: fullUrl,
                        name: $elem.find('.file-name, .name, td:first-child').text().trim() || 
                              link.text().trim() || null
                    });
                }
            }
        }
    });

    // Method 3: Extract links from HTML directly using regex
    const htmlStr = html.toString();
    const directPixelLinks = extractAllPixeldrainLinks(htmlStr);
    directPixelLinks.forEach(link => {
        if (!seen.has(link.id)) {
            seen.add(link.id);
            links.push(link);
        }
    });

    // Fetch individual file pages if needed and we don't have enough links
    if (links.length === 0 && fileLinks.length > 0) {
        console.log(`Fetching ${fileLinks.length} file pages...`);
        
        // Limit concurrent requests
        const batchSize = 5;
        for (let i = 0; i < fileLinks.length; i += batchSize) {
            const batch = fileLinks.slice(i, i + batchSize);
            const results = await Promise.all(
                batch.map(async (fileInfo) => {
                    try {
                        const pageLinks = await handleSinglePage(fileInfo.url);
                        return pageLinks.map(link => ({
                            ...link,
                            filename: fileInfo.name || link.filename
                        }));
                    } catch (e) {
                        console.log('Error fetching file page:', e.message);
                        return [];
                    }
                })
            );
            
            results.flat().forEach(link => {
                if (!seen.has(link.id)) {
                    seen.add(link.id);
                    links.push(link);
                }
            });
        }
    }

    console.log(`Found ${links.length} links in pack`);
    return links;
}

// Handle single file pages
async function handleSinglePage(url) {
    console.log('Handling single page:', url);
    const html = await fetchPage(url);
    if (!html) return [];

    const links = extractAllPixeldrainLinks(html);

    // If no links found, look for iframes or redirects
    if (links.length === 0) {
        const $ = cheerio.load(html);

        // Check iframes
        const iframeSrc = $('iframe[src*="pixeldrain"], iframe[src*="player"]').attr('src');
        if (iframeSrc) {
            const iframeHtml = await fetchPage(iframeSrc);
            if (iframeHtml) {
                const iframeLinks = extractAllPixeldrainLinks(iframeHtml);
                if (iframeLinks.length > 0) return iframeLinks;
            }
        }

        // Check for download buttons or links
        const downloadLink = $('a[href*="pixeldrain"], a.download-btn, a.btn-download, a[download], button[data-url]').first();
        if (downloadLink.length) {
            const href = downloadLink.attr('href') || downloadLink.attr('data-url');
            if (href) {
                const id = extractPixeldrainId(href);
                if (id) {
                    return [{
                        id,
                        apiUrl: `https://pixeldrain.com/api/file/${id}`,
                        filename: null
                    }];
                }
            }
        }

        // Check meta tags
        const metaUrl = $('meta[property="og:url"], meta[name="twitter:url"]').attr('content');
        if (metaUrl) {
            const id = extractPixeldrainId(metaUrl);
            if (id) {
                return [{
                    id,
                    apiUrl: `https://pixeldrain.com/api/file/${id}`,
                    filename: null
                }];
            }
        }
    }

    return links;
}

// Handle generic pages
async function handleGenericPage(url) {
    const html = await fetchPage(url);
    if (!html) return [];
    return extractAllPixeldrainLinks(html);
}

// Fetch page with retry
async function fetchPage(url, maxRetries = 3) {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios({
                method: 'GET',
                url: url,
                timeout: 20000,
                maxRedirects: 15,
                headers: {
                    'User-Agent': userAgents[i % userAgents.length],
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                validateStatus: status => status < 500
            });

            if (response.status === 200 && response.data) {
                return typeof response.data === 'string' ? response.data : response.data.toString();
            }

            // Handle redirects manually
            if (response.status >= 300 && response.status < 400 && response.headers.location) {
                return await fetchPage(response.headers.location, maxRetries - 1);
            }

            console.log(`Attempt ${i + 1}: Status ${response.status}`);
        } catch (error) {
            console.log(`Attempt ${i + 1} error:`, error.message);
            if (i === maxRetries - 1) throw error;
        }

        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }

    return null;
}

// Get Pixeldrain file info
async function getPixeldrainInfo(id) {
    try {
        const response = await axios({
            method: 'GET',
            url: `https://pixeldrain.com/api/file/${id}/info`,
            timeout: 10000,
            headers: {
                'Accept': 'application/json'
            }
        });

        if (response.status === 200 && response.data) {
            return response.data;
        }
    } catch (error) {
        console.log(`Failed to get info for ${id}:`, error.message);
    }
    return null;
}

// Extract Pixeldrain ID from URL
function extractPixeldrainId(url) {
    if (!url) return null;
    
    const patterns = [
        /pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/,
        /pixeldrain\.dev\/u\/([a-zA-Z0-9_-]+)/,
        /pixeldrain\.com\/api\/file\/([a-zA-Z0-9_-]+)/,
        /pixeldrain\.dev\/api\/file\/([a-zA-Z0-9_-]+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) return match[1];
    }

    return null;
}

// Extract all Pixeldrain links from HTML
function extractAllPixeldrainLinks(html) {
    const links = [];
    const seen = new Set();

    const patterns = [
        /https?:\/\/pixeldrain\.com\/u\/([a-zA-Z0-9_-]{6,})/gi,
        /https?:\/\/pixeldrain\.dev\/u\/([a-zA-Z0-9_-]{6,})/gi,
        /https?:\/\/pixeldrain\.com\/api\/file\/([a-zA-Z0-9_-]{6,})/gi,
        /["']https?:\/\/pixeldrain\.(?:com|dev)\/u\/([a-zA-Z0-9_-]{6,})["']/gi,
        /pixeldrain\.(?:com|dev)\/u\/([a-zA-Z0-9_-]{6,})/gi
    ];

    const htmlStr = typeof html === 'string' ? html : html.toString();

    for (const pattern of patterns) {
        let match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(htmlStr)) !== null) {
            const id = match[1];
            if (id && id.length >= 6 && id.length <= 20 && !seen.has(id)) {
                seen.add(id);
                links.push({
                    id: id,
                    apiUrl: `https://pixeldrain.com/api/file/${id}`,
                    filename: extractFilenameFromContext(htmlStr, match.index)
                });
            }
        }
    }

    return links;
}

// Extract filename from context
function extractFilenameFromContext(html, position) {
    const start = Math.max(0, position - 500);
    const end = Math.min(html.length, position + 500);
    const context = html.substring(start, end);

    const patterns = [
        /title=["']([^"']{3,100})["']/i,
        /data-name=["']([^"']{3,100})["']/i,
        />([^<]{3,100}\.(mkv|mp4|avi|mov|webm|flv|m4v|zip|rar|pdf|mp3|flac))</i,
        /download=["']([^"']{3,100})["']/i,
        /"name"\s*:\s*"([^"]{3,100})"/i
    ];

    const blacklist = ['pixeldrain', 'download', 'click', 'here', 'button', 'link', 'file'];

    for (const pattern of patterns) {
        const match = context.match(pattern);
        if (match && match[1]) {
            const filename = match[1].trim()
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'");

            const lower = filename.toLowerCase();
            if (!blacklist.some(word => lower === word || lower === word + 's')) {
                return filename;
            }
        }
    }

    return null;
}
