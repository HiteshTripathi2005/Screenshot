# Screenshot Microservice

This is an Express.js microservice for taking screenshots of deployed web apps, compressing them, and uploading them to Supabase Storage. It is designed for fast, asynchronous screenshot processing and minimal image size (target: ~25KB per screenshot).

## Features
- **POST `/api/fly/take-screenshot`**: Instantly responds to screenshot requests and processes them in the background.
- Uses Puppeteer to capture full-page screenshots of deployed apps (e.g., `https://kulp-<project_id>.fly.dev`).
- Compresses screenshots to JPEG, targeting ~25KB file size before upload.
- Uploads screenshots to Supabase Storage and updates the project record in the Supabase database.
- Cleans up local files after upload.
- Robust error handling and detailed logging.

## Usage

### 1. Install dependencies
```
pnpm install
```

### 2. Set up environment variables
Create a `.env` file in the root directory with:
```
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_service_role_key
```

### 3. Start the server
```
pnpm start
```

### 4. Make a screenshot request
Send a POST request to `http://localhost:3001/api/fly/take-screenshot` with JSON body:
```
{
  "project_id": "your_project_id"
}
```

The server will immediately respond with a status message. The screenshot will be processed and uploaded in the background.

## Project Structure
- `index.js` - Main server and screenshot logic
- `screenshots/` - Temporary storage for screenshots
- `package.json` - Project dependencies and scripts

## Notes
- Screenshots are compressed to be as close to 25KB as possible. If the page is very complex, quality and resolution will be reduced to meet this target.
- Make sure your Supabase bucket and table are set up as expected.

## License
MIT
