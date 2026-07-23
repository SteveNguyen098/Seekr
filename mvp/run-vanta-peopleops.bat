@echo off
cd /d "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\mvp"
npx tsx src/index.ts --job-url "https://jobs.ashbyhq.com/vanta/ac23b101-7664-4ba4-a70e-71cd13020d6d" --resume "C:\Users\stron\OneDrive\Desktop\Seekr\seekr\Seekr Resume Template.docx" --out ./out/vanta-peopleops --headed
pause
