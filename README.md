# Personal website

A one-page portfolio. The top of the page is a zen garden you rake by moving
the cursor; it ends in a curved shoreline over a koi pond under a sheet of
liquid glass, and both scroll with the page. The projects sit on foggy glass
cards from [liquid-glass-react](https://github.com/rdev/liquid-glass-react)
(refraction shows in Chromium; Safari and Firefox get the frost only).
Next.js 16 and Tailwind CSS; the scene is canvas plus one WebGL shader.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
```

Text and projects live in `src/content/site.ts`. The scene lives in `src/lib/`:
`sand.ts` (height-map sand and mossy stones), `garden.ts` (hover raking),
`koi.ts` (fish), `pond.ts` (caustics shader and render loop).
