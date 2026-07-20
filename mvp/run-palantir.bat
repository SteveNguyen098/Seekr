@echo off
cd /d "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\mvp"
npx tsx src/index.ts --career-url "https://jobs.lever.co/palantir" --resume "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\Seekr Resume Template.docx" --criteria "./criteria.json" --out ./out/palantir --headed
pause
