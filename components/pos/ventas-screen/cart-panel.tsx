"use client";

import { ShoppingBag, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStore } from "@/lib/store";
import { formatCurrency } from "@/lib/utils";
import { CartItemRow } from "./cart-item";
import { DiscountControl } from "./discount-control";

interface CartPanelProps {
  onCheckout: () => void;
  onCancelSale: () => void;
  onClose?: () => void;
}

export function CartPanel({ onCheckout, onCancelSale, onClose }: CartPanelProps) {
  const t = useTranslations("ventas.cart");
  const tVentas = useTranslations("ventas");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const cart = useStore((s) => s.cart);
  const removeFromCart = useStore((s) => s.removeFromCart);
  const updateCartQuantity = useStore((s) => s.updateCartQuantity);
  const updateCartItemPrice = useStore((s) => s.updateCartItemPrice);
  const getCartSubtotal = useStore((s) => s.getCartSubtotal);
  const getDiscountAmount = useStore((s) => s.getDiscountAmount);
  const getCartTotal = useStore((s) => s.getCartTotal);
  const discountPercent = useStore((s) => s.discountPercent);

  const cartSubtotal = getCartSubtotal();
  const discountAmount = getDiscountAmount();
  const cartTotal = getCartTotal();
  const hasDiscount = discountAmount > 0;
  const cartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <>
      <div className="flex h-14 items-center border-b px-5">
        <ShoppingBag className="h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
        <h3 className="ml-2 text-base font-extrabold text-foreground">{t("title")}</h3>
        <div className="flex-1" />
        <Badge variant="muted" size="chip" className="border-foreground px-2.5 py-1">
          {t("itemCount", { count: cartItemCount })}
        </Badge>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-2 h-8 w-8"
            onClick={onClose}
            aria-label={tVentas("closeCartAria")}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      <DiscountControl />

      <ScrollArea className="min-h-0 flex-1">
        {cart.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-5 py-16 text-center">
            <ShoppingBag
              className="mb-3 h-10 w-10 text-muted-foreground/40"
              aria-hidden="true"
            />
            <p className="text-xs font-semibold text-muted-foreground">
              {t("emptyTitle")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">{t("emptySubtitle")}</p>
          </div>
        ) : (
          <div className="divide-y px-4">
            {cart.map((item) => (
              <CartItemRow
                key={item.product.id}
                item={item}
                onUpdateQuantity={(qty) => updateCartQuantity(item.product.id, qty)}
                onUpdatePrice={(price) => updateCartItemPrice(item.product.id, price)}
                onRemove={() => removeFromCart(item.product.id)}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="px-5 py-4">
        {/* cart-percentage-discount.CART_TOTALS.1, cart-percentage-discount.CART_TOTALS.2, cart-percentage-discount.CART_TOTALS.4 (hidden when no discount, matching prior behavior) */}
        {hasDiscount && (
          <div className="mb-3 space-y-1 px-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{tCommon("subtotal")}</span>
              <span>{formatCurrency(cartSubtotal, locale)}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("discount", { percent: discountPercent })}</span>
              <span>-{formatCurrency(discountAmount, locale)}</span>
            </div>
          </div>
        )}

        {/* cart-percentage-discount.CART_TOTALS.3 */}
        <div className="mb-3 flex items-center justify-between rounded-xl bg-muted px-3 py-2.5">
          <span className="text-sm font-bold text-foreground">{tCommon("total")}</span>
          <span className="text-4xl font-extrabold leading-none tracking-[-1px] text-foreground">
            {formatCurrency(cartTotal, locale)}
          </span>
        </div>
        <Button
          size="lg"
          className="mb-2 w-full"
          disabled={cart.length === 0}
          onClick={onCheckout}
        >
          {t("charge")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={cart.length === 0}
          onClick={onCancelSale}
        >
          {t("cancelSale")}
        </Button>
      </div>
    </>
  );
}
