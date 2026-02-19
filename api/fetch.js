const axios = require('axios');

module.exports = async (req, res) => {
    // Set CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false,
            error: 'Method not allowed. Use POST.' 
        });
    }

    try {
        // Parse body
        let body = req.body;
        
        // Handle if body is string
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch (e) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Invalid JSON body' 
                });
            }
        }

        const { url } = body || {};

        if (!url) {
            return res.status(400).json({ 
                success: false,
                error: 'URL is required in request body' 
            });
        }

        // Validate URL format
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            return res.status(400).json({ 
                success: false,
                error: 'Invalid URL format' 
            });
        }

        // Check if URL is from supported domains
        const supportedDomains = ['hubcloud.lol', 'gdflix.dev', 'gdflix.cfd', 'hubcloud.club', 'hubcloud.art'];
        const hostname = parsedUrl.hostname.replace('www.', '');
        
        const isSupported = supportedDomains.some(domain => hostname.includes(domain));
        
        if (!isSupported) {
            // Check if it's already a pixeldrain link
            if (hostname.includes('pixeldrain')) {
                const pixeldrainId = extractPixeldrainIdFromUrl(url);
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
        }

        console.log('Fetching URL:', url);

        // Fetch the page content
        const html = await fetchWithRetry(url);

        if (!html) {
            return res.status(500).json({ 
                success: false,
                error: 'Failed to fetch page content' 
            });
        }

        // Extract Pixeldrain links
        const pixeldrainLinks = extractPixeldrainLinks(html, url);

        if (pixeldrainLinks.length === 0) {
            // Try to find redirect or iframe URLs
            const redirectUrl = findRedirectUrl(html);
            
            if (redirectUrl) {
                console.log('Found redirect URL:', redirectUrl);
                const redirectHtml = await fetchWithRetry(redirectUrl);
                
                if (redirectHtml) {
                    const redirectLinks = extractPixeldrainLinks(redirectHtml, redirectUrl);
                    
                    if (redirectLinks.length > 0) {
                        return sendResponse(res, url, redirectLinks);
                    }
                }
            }

            return res.status(404).json({ 
                success: false,
                error: 'No Pixeldrain links found on this page. The page might use dynamic loading or the format is not supported.' 
            });
        }

        return sendResponse(res, url, pixeldrainLinks);

    } catch (error) {
        console.error('Server error:', error);
        
        // Return proper JSON error
        return res.status(500).json({ 
            success: false,
            error: error.message || 'Internal server error',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

// Send response helper
function sendResponse(res, originalUrl, links) {
    if (links.length > 1) {
        // Multiple links (pack)
        const items = links.map((link, index) => ({
            original: originalUrl,
            pixeldrain_api: link.apiUrl,
            filename: link.filename || `File ${index + 1}`
        }));

        return res.status(200).json({
            success: true,
            isPack: true,
            count: items.length,
            items: items
        });
    }

    // Single link
    const link = links[0];
    return res.status(200).json({
        success: true,
        isPack: false,
        original: originalUrl,
        pixeldrain_api: link.apiUrl,
        filename: link.filename || null
    });
}

// Fetch with retry and proper error handling
async function fetchWithRetry(url, retries = 3) {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
    ];

    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios({
                method: 'GET',
                url: url,
                timeout: 20000,
                maxRedirects: 10,
                headers: {
                    'User-Agent': userAgents[i % userAgents.length],
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Cache-Control': 'max-age=0',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1'
                },
                validateStatus: (status) => status < 500
            });

            if (response.status === 200) {
                return response.data;
            }

            // Handle redirects manually if needed
            if (response.status >= 300 && response.status < 400) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    return await fetchWithRetry(redirectUrl, retries - 1);
                }
            }

            console.log(`Attempt ${i + 1} failed with status:`, response.status);
        } catch (error) {
            console.log(`Attempt ${i + 1} error:`, error.message);
            
            if (i === retries - 1) {
                throw new Error(`Failed to fetch after ${retries} attempts: ${error.message}`);
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }

    return null;
}

// Extract Pixeldrain ID from direct URL
function extractPixeldrainIdFromUrl(url) {
    const patterns = [
        /pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/i,
        /pixeldrain\.dev\/u\/([a-zA-Z0-9_-]+)/i,
        /pixeldrain\.com\/api\/file\/([a-zA-Z0-9_-]+)/i,
        /pixeldrain\.dev\/api\/file\/([a-zA-Z0-9_-]+)/i
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    return null;
}

// Extract all Pixeldrain links from HTML
function extractPixeldrainLinks(html, sourceUrl) {
    const links = [];
    const seen = new Set();

    // Convert HTML to string if needed
    const htmlStr = typeof html === 'string' ? html : String(html);

    // Multiple patterns to catch different formats
    const patterns = [
        // Standard URLs
        /https?:\/\/pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/gi,
        /https?:\/\/pixeldrain\.dev\/u\/([a-zA-Z0-9_-]+)/gi,
        
        // API URLs
        /https?:\/\/pixeldrain\.com\/api\/file\/([a-zA-Z0-9_-]+)/gi,
        /https?:\/\/pixeldrain\.dev\/api\/file\/([a-zA-Z0-9_-]+)/gi,
        
        // Without protocol
        /["'](?:https?:)?\/\/pixeldrain\.(?:com|dev)\/u\/([a-zA-Z0-9_-]+)["']/gi,
        
        // In href attributes
        /href=["'][^"']*pixeldrain\.(?:com|dev)\/u\/([a-zA-Z0-9_-]+)[^"']*["']/gi,
        
        // In onclick or JavaScript
        /(?:window\.open|location\.href)\s*[=(]\s*["'][^"']*pixeldrain\.(?:com|dev)\/u\/([a-zA-Z0-9_-]+)[^"']*["']/gi,
        
        // Encoded URLs
        /pixeldrain\.(?:com|dev)%2Fu%2F([a-zA-Z0-9_-]+)/gi,
        /pixeldrain\.(?:com|dev)\/u\/([a-zA-Z0-9_-]+)/gi
    ];

    for (const pattern of patterns) {
        let match;
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0;
        
        while ((match = pattern.exec(htmlStr)) !== null) {
            const id = match[1];
            
            // Validate ID (should be alphanumeric, typically 8-12 chars)
            if (id && id.length >= 6 && id.length <= 20 && !seen.has(id)) {
                seen.add(id);
                
                // Try to extract filename from context
                const filename = extractFilename(htmlStr, match.index, id);
                
                links.push({
                    id: id,
                    apiUrl: `https://pixeldrain.com/api/file/${id}`,
                    filename: filename
                });
            }
        }
    }

    return links;
}

// Find redirect URLs in HTML
function findRedirectUrl(html) {
    const htmlStr = typeof html === 'string' ? html : String(html);
    
    // Patterns for finding redirect URLs
    const patterns = [
        // Meta refresh
        /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'\s>]+)/i,
        
        // JavaScript redirects
        /window\.location\s*=\s*["']([^"']+)["']/i,
        /window\.location\.href\s*=\s*["']([^"']+)["']/i,
        /location\.replace\s*\(\s*["']([^"']+)["']/i,
        
        // Form actions
        /action=["']([^"']*pixeldrain[^"']*)["']/i,
        
        // Iframe sources
        /<iframe[^>]*src=["']([^"']+)["']/i,
        
        // Data attributes
        /data-url=["']([^"']+)["']/i,
        /data-href=["']([^"']+)["']/i
    ];

    for (const pattern of patterns) {
        const match = htmlStr.match(pattern);
        if (match && match[1]) {
            const url = match[1].trim();
            // Check if it looks like a valid URL
            if (url.startsWith('http') || url.startsWith('//')) {
                return url.startsWith('//') ? 'https:' + url : url;
            }
        }
    }

    return null;
}

// Extract filename from HTML context
function extractFilename(html, position, pixeldrainId) {
    // Get context around the link (before and after)
    const start = Math.max(0, position - 1000);
    const end = Math.min(html.length, position + 1000);
    const context = html.substring(start, end);

    // Patterns to find filename
    const patterns = [
        // Common attribute patterns
        /data-name=["']([^"']+)["']/i,
        /data-filename=["']([^"']+)["']/i,
        /data-title=["']([^"']+)["']/i,
        /title=["']([^"']+)["']/i,
        
        // Download attribute
        /download=["']([^"']+)["']/i,
        
        // Text content patterns (file extensions)
        />([^<]+\.(?:mkv|mp4|avi|mov|webm|flv|wmv|m4v|3gp))</i,
        />([^<]+\.(?:mp3|flac|wav|aac|ogg|wma|m4a))</i,
        />([^<]+\.(?:zip|rar|7z|tar|gz|iso))</i,
        />([^<]+\.(?:pdf|doc|docx|txt|epub))</i,
        
        // JSON-like patterns
        /"name"\s*:\s*"([^"]+)"/i,
        /"filename"\s*:\s*"([^"]+)"/i,
        /"title"\s*:\s*"([^"]+)"/i,
        
        // Alt text
        /alt=["']([^"']+)["']/i
    ];

    for (const pattern of patterns) {
        const match = context.match(pattern);
        if (match && match[1]) {
            let filename = match[1].trim();
            
            // Clean up filename
            filename = filename.replace(/&amp;/g, '&')
                              .replace(/&lt;/g, '<')
                              .replace(/&gt;/g, '>')
                              .replace(/&quot;/g, '"')
                              .replace(/&#39;/g, "'");
            
            // Filter out generic/invalid names
            const invalidNames = [
                'pixeldrain', 'download', 'click here', 'click to download',
                'file', 'link', 'button', 'submit', 'open', 'play',
                'loading', 'please wait', 'redirect'
            ];
            
            const lowerFilename = filename.toLowerCase();
            const isInvalid = invalidNames.some(name => lowerFilename.includes(name)) ||
                             filename.length < 3 ||
                             filename.length > 200;
            
            if (!isInvalid) {
                return filename;
            }
        }
    }

    return null;
}
