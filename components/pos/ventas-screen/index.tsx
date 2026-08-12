"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ShoppingBag, X, Zap } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckoutDialog } from "@/components/pos/checkout-dialog";
import { QuickSaleDialog } from "@/components/pos/quick-sale-dialog";
import { SearchBar } from "@/components/pos/search-bar";
import { UnregisteredProductSheet } from "@/components/pos/unregistered-product-sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { CATEGORY_COLOR_MAP } from "@/lib/category-colors";
import { getProductDisplayName } from "@/lib/mappers";
import { type Product, useStore } from "@/lib/store";
import { cn, formatCurrency } from "@/lib/utils";
import { CartPanel } from "./cart-panel";
import { frequentProductsQueryKey, frequentProductsQueryOptions } from "./query";
import { useProductSearch } from "./use-product-search";

export function VentasScreen() {
  const t = useTranslations("ventas");
  const tCommon = useTranslations("common");
  const tToast = useTranslations("ventas.toast");
  const locale = useLocale();
  const [showUnregistered, setShowUnregistered] = useState(false);
  const [unregisteredBarcode, setUnregisteredBarcode] = useState("");
  const [showCheckout, setShowCheckout] = useState(false);
  const [showQuickSale, setShowQuickSale] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const {
    searchForm,
    searchValue,
    searchResults,
    isSearching,
    isDebouncing,
    isSubmitting,
    handleSubmit,
    clearSearchAndFocus,
    inputRef,
    focusInput,
  } = useProductSearch({
    onUnregistered: (barcode) => {
      setUnregisteredBarcode(barcode);
      setShowUnregistered(true);
    },
  });

  const cart = useStore((s) => s.cart);
  const addToCart = useStore((s) => s.addToCart);
  const clearCart = useStore((s) => s.clearCart);
  const getCartTotal = useStore((s) => s.getCartTotal);

  const cartTotal = getCartTotal();
  const cartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  const queryClient = useQueryClient();
  const { data: frequentProducts = [] } = useQuery(frequentProductsQueryOptions());

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2" || (e.ctrlKey && e.key === "Enter")) {
        e.preventDefault();
        if (cart.length > 0) setShowCheckout(true);
      }
      if (e.key === "F4") {
        e.preventDefault();
        setShowQuickSale(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cart.length]);

  const handleProductClick = (product: Product) => {
    addToCart(product);
    toast.success(
      tToast("added", {
        name: getProductDisplayName(product, tCommon("unnamedProduct")),
      })
    );
    focusInput();
  };

  const handleCancelSale = () => {
    if (cart.length === 0) return;
    setShowCancelConfirm(true);
  };

  const handleConfirmCancel = () => {
    clearCart();
    toast.info(tToast("cancelled"));
    focusInput();
  };

  const handleSaleComplete = () => {
    focusInput();
    queryClient.invalidateQueries({ queryKey: frequentProductsQueryKey });
  };

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Left column - Product entry */}
      <div className="flex flex-1 flex-col overflow-hidden border-b p-4 md:border-b-0 md:p-5">
        {/* Barcode input */}
        <Form {...searchForm}>
          <form onSubmit={searchForm.handleSubmit(handleSubmit)} className="mb-4">
            <FormField
              control={searchForm.control}
              name="searchValue"
              render={({ field }) => {
                const { ref, ...fieldProps } = field;

                return (
                  <FormItem className="space-y-0">
                    <SearchBar animated className="h-12">
                      {isSubmitting ? (
                        <Spinner className="h-5 w-5 shrink-0 text-foreground" />
                      ) : (
                        <Search className="h-5 w-5 shrink-0 text-foreground" />
                      )}
                      <FormControl>
                        <Input
                          ref={(element) => {
                            ref(element);
                            inputRef.current = element;
                          }}
                          type="text"
                          inputMode="search"
                          autoComplete="off"
                          aria-label={t("searchAria")}
                          placeholder={t("searchPlaceholder")}
                          className="h-full flex-1 border-0 bg-transparent p-0 text-sm font-medium shadow-none placeholder:font-medium placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                          autoFocus
                          disabled={isSubmitting}
                          {...fieldProps}
                        />
                      </FormControl>
                      {searchValue.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-accent-foreground"
                          onClick={clearSearchAndFocus}
                          aria-label={t("clearSearchAria")}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                      <Button
                        type="button"
                        onClick={() => setShowQuickSale(true)}
                        size="sm"
                        className="shrink-0"
                        aria-label={t("quickSaleAria")}
                      >
                        <Zap className="h-3.5 w-3.5" />
                        <span className="hidden text-xs font-semibold md:inline">
                          {t("quickSaleButton")}
                        </span>
                      </Button>
                    </SearchBar>
                  </FormItem>
                );
              }}
            />
          </form>
        </Form>

        {/* Search results dropdown */}
        {searchValue.length >= 2 && (
          <div className="mb-4 max-h-48 overflow-auto rounded-md border bg-card shadow-md">
            {isSearching || isDebouncing ? (
              <div className="flex items-center justify-center py-4">
                <Spinner />
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-6 text-center">
                <Search
                  className="mb-2 h-6 w-6 text-muted-foreground/50"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium text-foreground">
                  {t("noProductsFound")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("pressEnterToRegister")}
                </p>
              </div>
            ) : (
              searchResults.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => {
                    addToCart(p);
                    toast.success(
                      tToast("added", {
                        name: getProductDisplayName(p, tCommon("unnamedProduct")),
                      })
                    );
                    clearSearchAndFocus();
                  }}
                  // biome-ignore lint/security/noSecrets: translation message key, not a secret
                  aria-label={t("addToCartAria", {
                    name: getProductDisplayName(p, tCommon("unnamedProduct")),
                    price: formatCurrency(p.price, locale),
                  })}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  <div>
                    <span className="font-medium text-foreground">
                      {getProductDisplayName(p, tCommon("unnamedProduct"))}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {p.barcode}
                    </span>
                  </div>
                  <span className="font-semibold text-foreground">
                    {formatCurrency(p.price, locale)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* Frequent products grid */}
        <div className="flex-1 overflow-auto">
          <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.8px] text-foreground">
            {t("frequentProducts")}
          </h3>
          <div className="grid grid-cols-2 gap-[10px] md:grid-cols-4">
            {frequentProducts.map((product) => (
              <button
                type="button"
                key={product.id}
                onClick={() => handleProductClick(product)}
                // biome-ignore lint/security/noSecrets: translation message key, not a secret
                aria-label={t("addToCartAria", {
                  name: getProductDisplayName(product, tCommon("unnamedProduct")),
                  price: formatCurrency(product.price, locale),
                })}
                className="flex h-[100px] flex-row items-stretch overflow-hidden rounded-2xl border bg-card text-left transition-all hover:border-primary/40 hover:shadow-xs active:scale-[0.98]"
              >
                <div
                  className="w-1.5 shrink-0"
                  style={{ background: CATEGORY_COLOR_MAP[product.category] }}
                />
                <div className="flex flex-1 flex-col justify-between gap-2 p-3.5">
                  <span className="line-clamp-2 text-[13px] font-semibold uppercase leading-tight text-product-title">
                    {getProductDisplayName(product, tCommon("unnamedProduct"))}
                  </span>
                  <span className="text-xl font-extrabold tracking-[-0.5px] text-foreground">
                    {formatCurrency(product.price, locale)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile cart toggle button - fixed at bottom on small screens */}
      <div className="border-t bg-card p-3 md:hidden">
        <Button
          className="w-full"
          onClick={() => setMobileCartOpen(true)}
          aria-label={t("viewCartAria", {
            count: cartItemCount,
            total: formatCurrency(cartTotal, locale),
          })}
        >
          <ShoppingBag className="mr-2 h-4 w-4" aria-hidden="true" />
          {t("viewCart")}
          {cartItemCount > 0 && (
            <Badge variant="inverted" size="chip" className="ml-2 rounded-full">
              {cartItemCount}
            </Badge>
          )}
          <span className="ml-auto font-bold">{formatCurrency(cartTotal, locale)}</span>
        </Button>
      </div>

      {/* Mobile cart overlay */}
      {mobileCartOpen && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-foreground/40 md:hidden"
          onClick={() => setMobileCartOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMobileCartOpen(false);
          }}
          aria-label={t("closeCartAria")}
        />
      )}

      {/* Mobile cart drawer (slides up from bottom) */}
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex h-[85dvh] flex-col rounded-t-xl bg-card pb-[constant(safe-area-inset-bottom)] pb-[env(safe-area-inset-bottom,0px)] shadow-xl transition-transform duration-300 md:hidden",
          mobileCartOpen ? "translate-y-0" : "translate-y-full"
        )}
      >
        <CartPanel
          onCheckout={() => {
            setShowCheckout(true);
            setMobileCartOpen(false);
          }}
          onCancelSale={handleCancelSale}
          onClose={() => setMobileCartOpen(false)}
        />
      </div>

      {/* Desktop cart sidebar - hidden on mobile */}
      <div className="hidden py-3 md:flex">
        <div className="flex w-[380px] flex-col overflow-hidden rounded-3xl border bg-card">
          <CartPanel
            onCheckout={() => setShowCheckout(true)}
            onCancelSale={handleCancelSale}
          />
        </div>
      </div>

      {/* Unregistered product sheet */}
      <UnregisteredProductSheet
        open={showUnregistered}
        onOpenChange={(open) => {
          setShowUnregistered(open);
          if (!open) focusInput();
        }}
        barcode={unregisteredBarcode}
        onComplete={focusInput}
      />

      {/* Checkout dialog */}
      <CheckoutDialog
        open={showCheckout}
        onOpenChange={(open) => {
          setShowCheckout(open);
          if (!open) focusInput();
        }}
        onComplete={handleSaleComplete}
      />

      {/* Quick sale dialog */}
      <QuickSaleDialog
        open={showQuickSale}
        onOpenChange={(open) => {
          setShowQuickSale(open);
          if (!open) focusInput();
        }}
        onComplete={focusInput}
      />

      {/* Cancel sale confirmation */}
      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cancelSaleTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("cancelSaleDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancelSaleNo")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmCancel}>
              {t("cancelSaleYes")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
