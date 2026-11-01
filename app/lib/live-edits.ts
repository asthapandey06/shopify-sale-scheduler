import { moneyEquals } from "./money.ts";
import { ITEM_STATUS } from "./sale-types.ts";

interface LiveCheckItem {
  id: string;
  variantId: string;
  status: string;
  salePrice: string;
}

/**
 * Items the sale put on sale whose live price is no longer the sale price, i.e. the merchant changed it while the
 * sale runs. Returns item id -> live price. Variants missing from `live` (deleted, or the lookup failed) are not
 * reported: the end of the sale decides those.
 */
export function findLiveEdits(items: LiveCheckItem[], live: Map<string, { price: string }>): Map<string, string> {
  const edited = new Map<string, string>();
  for (const item of items) {
    if (item.status !== ITEM_STATUS.APPLIED) continue;
    const current = live.get(item.variantId);
    if (current && !moneyEquals(current.price, item.salePrice)) edited.set(item.id, current.price);
  }
  return edited;
}
