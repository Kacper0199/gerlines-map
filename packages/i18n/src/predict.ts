import { type PredictPageCopy, predictCopyFor } from "./copy-predict.ts";
import { useLocale } from "./react.ts";

export {
  PIEBRO_SOURCE_NAME,
  type PredictCopy,
  type PredictPageCopy,
  predictCopyFor,
} from "./copy-predict.ts";

export function usePredictCopy(): PredictPageCopy {
  return predictCopyFor(useLocale());
}
