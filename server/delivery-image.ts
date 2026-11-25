import sharp from "sharp";

export async function composeVerticalImages(images: Buffer[], width: number) {
  const slices = await Promise.all(images.map((bytes) => sharp(bytes)
    .resize({ width }).png().toBuffer({ resolveWithObject: true })));
  let height = 0;
  const composites = slices.map((slice) => {
    const top = height;
    height += slice.info.height;
    return { input: slice.data, top, left: 0 };
  });
  return sharp({ create: { width, height, channels: 4, background: "white" } }).composite(composites);
}
