const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const app = express();
const port = 3001;

// Middleware
app.use(cors({ origin: '*' })); // Allow all origins for CORS
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create screenshots directory if it doesn't exist
const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir);
    console.log(`Created screenshots directory at: ${screenshotsDir}`);
}

async function processAndUploadImage(imagePath, projectId) {
    console.log('Processing and uploading image to Supabase...');
    const processStartTime = process.hrtime();

    try {
        // Read and process image with sharp
        const image = await sharp(imagePath)
            // Convert to JPEG with lower quality and smaller resolution
            .jpeg({ quality: 40, progressive: true })
            .resize(800, null, { 
                withoutEnlargement: true,
                fit: 'inside'
            });

        // Get processed image buffer
        let processedImageBuffer = await image.toBuffer();
        
        const originalSize = fs.statSync(imagePath).size / 1024;
        let compressedSize = processedImageBuffer.length / 1024;
        console.log(`Image compressed from ${originalSize.toFixed(1)}KB to ${compressedSize.toFixed(1)}KB`);

        // If still over 30KB, try more aggressive compression
        if (compressedSize > 30) {
            const recompressedImage = await sharp(processedImageBuffer)
                .jpeg({ quality: 20, progressive: true })
                .resize(600, null, {
                    withoutEnlargement: true,
                    fit: 'inside'
                });
            const reprocessedBuffer = await recompressedImage.toBuffer();
            const recompressedSize = reprocessedBuffer.length / 1024;
            console.log(`Image recompressed to ${recompressedSize.toFixed(1)}KB`);
            if (recompressedSize <= 30) {
                processedImageBuffer = reprocessedBuffer;
                compressedSize = recompressedSize;
            }
        }

        // Upload to Supabase
        const bucketName = 'projects';
        const filePath = `screenshots/${projectId}.jpg`;

        // Try to remove existing file first
        try {
            await supabase.storage
                .from(bucketName)
                .remove([filePath]);
            console.log('Removed existing screenshot');
        } catch (e) {
            console.log('No existing screenshot to remove or error removing:', e.message);
        }

        // Upload new file
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from(bucketName)
            .upload(filePath, processedImageBuffer, {
                contentType: 'image/jpeg',
                upsert: true
            });

        if (uploadError) throw uploadError;

        // Get public URL with timestamp to prevent caching
        const timestamp = Date.now();
        const { data: { publicUrl } } = supabase.storage
            .from(bucketName)
            .getPublicUrl(`${filePath}?v=${timestamp}`);

        // Update project in database
        const { data: updateData, error: updateError } = await supabase
            .from('projects')
            .update({ 
                screenshot: publicUrl,
                updated_at: new Date().toISOString()
            })
            .eq('id', projectId);

        if (updateError) throw updateError;

        const processDuration = process.hrtime(processStartTime);
        console.log(`Image processed and uploaded in ${processDuration[0]}s ${processDuration[1] / 1000000}ms`);

        return {
            success: true,
            url: publicUrl,
            size: compressedSize
        };

    } catch (error) {
        console.error('Error processing/uploading image:', error);
        throw error;
    }
}

// Screenshot route (POST)
app.post('/api/fly/take-screenshot', async (req, res) => {
    const startTime = process.hrtime();
    const startMemory = process.memoryUsage();
    console.log(`[${new Date().toISOString()}] New screenshot request received`);

    try {
        const { project_id: id } = req.body;
        
        if (!id) {
            console.warn('Request rejected: Missing ID');
            return res.status(400).json({ error: 'ID is required in request body' });
        }

        // Send immediate response to avoid blocking the user
        res.json({
            status: 'processing',
            message: 'Screenshot request received and is being processed',
            app_name: `kulp-${id}`,
            project_id: id
        });
        console.log(`[${new Date().toISOString()}] Immediate response sent, processing screenshot asynchronously`);

        processScreenshotAsync(id, startTime, startMemory);

    } catch (error) {
        console.error('Request handling error:', error);
        res.status(500).json({ error: 'Failed to process screenshot request' });
    }
});

// Async function to process screenshot without blocking the response
async function processScreenshotAsync(id, startTime, startMemory) {
    let filepath;
    try {
        // First check if the app is available
        const appUrl = `https://kulp-${id}.fly.dev`;
        console.log(`Checking availability for: ${appUrl}`);

        // Check if app is responding before taking screenshot
        try {
            const checkResponse = await fetch(`${appUrl}?_health_check=${Date.now()}`, {
                timeout: 10000,
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });

            if (!checkResponse.ok) {
                console.warn(`App not ready: ${appUrl} returned ${checkResponse.status}`);
                return;
            }
        } catch (checkError) {
            console.error('App availability check failed:', checkError);
            return;
        }

        // Launch browser with enhanced options
        console.log('Launching browser...');
        const browserStartTime = process.hrtime();
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1920,1080',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-plugins'
            ]
        });
        const browserLaunchDuration = process.hrtime(browserStartTime);
        console.log(`Browser launched in ${browserLaunchDuration[0]}s ${browserLaunchDuration[1] / 1000000}ms`);

        const page = await browser.newPage();
        console.log('New page created');

        // Set viewport size
        await page.setViewport({
            width: 1920,
            height: 1080
        });
        console.log('Viewport set to 1920x1080');

        // Navigate to URL with cache busting
        console.log(`Navigating to ${appUrl}...`);
        const navigationStartTime = process.hrtime();
        await page.goto(`${appUrl}?_screenshot=${Date.now()}`, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Wait for any loading indicators to disappear
        const loadingSelectors = [
            '[data-testid="loading"]',
            '.loading',
            '.spinner',
            '.loader',
            '[class*="loading"]',
            '[class*="spinner"]'
        ];

        for (const selector of loadingSelectors) {
            try {
                await page.waitForFunction(
                    (sel) => !document.querySelector(sel),
                    { timeout: 5000 },
                    selector
                );
            } catch (e) {
                // Ignore timeout if selector not found
            }
        }

        // Additional wait for dynamic content
        await page.waitForTimeout(2000);

        const navigationDuration = process.hrtime(navigationStartTime);
        console.log(`Page loaded in ${navigationDuration[0]}s ${navigationDuration[1] / 1000000}ms`);

        // Generate unique filename with project ID
        const filename = `screenshot-${id}-${Date.now()}.png`;
        filepath = path.join(screenshotsDir, filename);
        console.log(`Taking screenshot: ${filename}`);

        // Take screenshot
        const screenshotStartTime = process.hrtime();
        await page.screenshot({
            path: filepath,
            fullPage: true
        });
        const screenshotDuration = process.hrtime(screenshotStartTime);
        console.log(`Screenshot saved in ${screenshotDuration[0]}s ${screenshotDuration[1] / 1000000}ms`);

        // Get file size
        const stats = fs.statSync(filepath);
        console.log(`Screenshot size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

        // Close browser
        await browser.close();
        console.log('Browser closed');

        // Process and upload to Supabase
        const uploadResult = await processAndUploadImage(filepath, id);

        // Cleanup: Remove the screenshot file
        try {
            fs.unlinkSync(filepath);
            console.log('Screenshot file cleaned up successfully');
        } catch (cleanupError) {
            console.warn('Failed to cleanup screenshot file:', cleanupError);
        }

        // Calculate total duration and memory usage
        const endMemory = process.memoryUsage();
        const duration = process.hrtime(startTime);
        console.log(`Total processing time: ${duration[0]}s ${duration[1] / 1000000}ms`);
        console.log('Memory usage difference:');
        console.log({
            heapUsed: `${((endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024).toFixed(2)} MB`,
            heapTotal: `${((endMemory.heapTotal - startMemory.heapTotal) / 1024 / 1024).toFixed(2)} MB`,
            external: `${((endMemory.external - startMemory.external) / 1024 / 1024).toFixed(2)} MB`,
            rss: `${((endMemory.rss - startMemory.rss) / 1024 / 1024).toFixed(2)} MB`
        });

        console.log(`[${new Date().toISOString()}] Screenshot processing completed successfully for project ${id}`);
        console.log(`Screenshot URL: ${uploadResult.url}`);
        console.log(`Size: ${uploadResult.size.toFixed(1)}KB\n`);

    } catch (error) {
        console.error('Screenshot processing error:', error);
        console.error('Stack trace:', error.stack);
        
        // Cleanup: Remove the screenshot file even if there was an error
        try {
            if (filepath && fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
                console.log('Screenshot file cleaned up after error');
            }
        } catch (cleanupError) {
            console.warn('Failed to cleanup screenshot file after error:', cleanupError);
        }
        
        const duration = process.hrtime(startTime);
        console.error(`Screenshot processing failed after ${duration[0]}s ${duration[1] / 1000000}ms\n`);
    }
}

app.listen(port, () => {
    const memoryUsage = process.memoryUsage();
    console.log(`Server running at http://localhost:${port}`);
    console.log('Initial memory usage:');
    console.log({
        heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`,
        rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`
    });
});