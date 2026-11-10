import { z } from "zod";
import { TrainPhoto } from "./train-detail.ts";

export const PHOTOS_PATH = "/api/v1/photos";

/** One entry of the photo credits page: the photo with the name of its series. */
export const PhotoCredit = TrainPhoto.extend({ seriesName: z.string().trim().min(1) });

export const PhotoCredits = z.object({ photos: z.array(PhotoCredit) });

export type PhotoCredit = z.infer<typeof PhotoCredit>;
export type PhotoCredits = z.infer<typeof PhotoCredits>;
