// Vercel Serverless Function
const https = require('https');
const http = require('http');

module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Validate URL
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid URL format' });
        }

        // Fetch the URL
        const html = await fetchUrl(url);

        // Extract Pixeldrain links
        const pixeldrainLinks = extractPixeldrainLinks(html);

        if (pixeldrainLinks.length === 0) {
            return res.status(404).json({ 
                error: 'No Pixeldrain links found in the provided URL' 
            });
        }

        // Check if it's a pack (multiple links)
        if (pixeldrainLinks.length > 1) {
            const items = pixeldrainLinks.map((link, index) => ({
                original: url,
                pixeldrain_api: link.apiUrl,
                filename: link.filename || `File ${index + 1}`
            }));

            return res.status(200).json({
                isPack: true,
                count: items.length,
                items: items
            });
        }

        // Single link
        const link = pixeldrainLinks[0];
        return res.status(200).json({
            original: url,
            pixeldrain_api: link.apiUrl,
            filename: link.filename || null,
            isPack: false
        });

    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({ 
            error: error.message || 'Internal server error' 
        });
    }
};

// Fetch URL with redirect following
function fetchUrl(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects === 0) {
            return reject(new Error('Too many redirects'));
        }

        const parsedUrl = new URL(url);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 15000
        };

        const request = protocol.get(url, options, (response) => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                const redirectUrl = new URL(response.headers.location, url).toString();
                return fetchUrl(redirectUrl, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                return reject(new Error(`HTTP ${response.statusCode}: Failed to fetch URL`));
            }

            let data = '';
            response.on('data', chunk => {
                data += chunk;
            });

            response.on('end', () => {
                resolve(data);
            });
        });

        request.on('error', (error) => {
            reject(new Error(`Network error: ${error.message}`));
        });

        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

// Extract Pixeldrain links from HTML
function extractPixeldrainLinks(html) {
    const links = [];
    const seen = new Set();

    // Patterns to match Pixeldrain URLs
    const patterns = [
        /https?:\/\/pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/gi,
        /https?:\/\/pixeldrain\.dev\/u\/([a-zA-Z0-9_-]+)/gi,
        /pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/gi,
        /pixeldrain\.dev\/u\/([a-zA-Z0-9_-]+)/gi
    ];

    patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(html)) !== null) {
            const id = match[1];
            
            if (!seen.has(id)) {
                seen.add(id);
                
                // Try to extract filename from surrounding context
                const filename = extractFilename(html, match.index);
                
                links.push({
                    id: id,
                    apiUrl: `https://pixeldrain.com/api/file/${id}`,
                    filename: filename
                });
            }
        }
    });

    return links;
}

// Try to extract filename from HTML context
function extractFilename(html, position) {
    // Look for common filename patterns near the link
    const context = html.substring(Math.max(0, position - 500), position + 500);
    
    // Patterns for filename detection
    const patterns = [
        /title["']?\s*[:=]\s*["']([^"']+)["']/i,
        /name["']?\s*[:=]\s*["']([^"']+)["']/i,
        /filename["']?\s*[:=]\s*["']([^"']+)["']/i,
        /<title>([^<]+)<\/title>/i,
        /data-title=["']([^"']+)["']/i,
        /alt=["']([^"']+)["']/i
    ];

    for (const pattern of patterns) {
        const match = context.match(pattern);
        if (match && match[1]) {
            const filename = match[1].trim();
            // Filter out generic titles
            if (filename.length > 3 && 
                !filename.toLowerCase().includes('pixeldrain') &&
                !filename.toLowerCase().includes('download') &&
                !filename.toLowerCase().includes('click here')) {
                return filename;
            }
        }
    }

    return null;
}
