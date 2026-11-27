export const imageTypes = ["image/png", "image/jpeg", "image/webp"];
export const maxImageBytes = 8 * 1024 * 1024;
export const maxImages = 4;
export const chatImageUrl = (id: string) =>
  "/api/v1/conversation/images/" + encodeURIComponent(id);
