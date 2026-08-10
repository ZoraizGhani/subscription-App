(function () {
  function formatMoney(cents, format) {
    // Falls back to a plain decimal if the shop's money format isn't available
    // on window (older themes don't always expose Shopify.money_format).
    const amount = (cents / 100).toFixed(2);
    if (!format) return amount;
    return format.replace(/\{\{\s*amount\s*\}\}/, amount);
  }

  function initWidget(root) {
    if (root.dataset.subscriptionWidgetInitialized) return;
    root.dataset.subscriptionWidgetInitialized = "true";

    const productJson = root.querySelector("[data-subscription-widget-product]");
    const product = JSON.parse(productJson.textContent);
    const settingsJson = root.querySelector("[data-subscription-widget-settings]");
    const settings = JSON.parse(settingsJson.textContent);

    const optionEls = Array.from(root.querySelectorAll("[data-option-index]"));
    const quantityInput = root.querySelector("[data-quantity-input]");
    const decreaseBtn = root.querySelector("[data-quantity-decrease]");
    const increaseBtn = root.querySelector("[data-quantity-increase]");
    const submitBtn = root.querySelector("[data-add-to-cart]");
    const statusEl = root.querySelector("[data-status]");

    const planSelect = root.querySelector("[data-plan-select]");
    const modeInputs = Array.from(root.querySelectorAll("[data-plan-mode]"));
    const discountPercentEl = root.querySelector("[data-discount-percent]");
    const comparePriceEl = root.querySelector("[data-compare-price]");
    const planPriceEl = root.querySelector("[data-plan-price]");
    const priceUnitEl = root.querySelector("[data-price-unit]");
    const bestValueBadgeEl = root.querySelector("[data-best-value-badge]");
    const onetimePriceEl = root.querySelector("[data-onetime-price]");

    const moneyFormat = window.Shopify && window.Shopify.money_format;

    if (priceUnitEl && settings.priceUnitSuffix) {
      priceUnitEl.textContent = `/ ${settings.priceUnitSuffix}`;
      priceUnitEl.hidden = false;
    }

    function selectedOptionValues() {
      return optionEls.map((optionEl) => {
        const selected = optionEl.querySelector("[data-option-value].is-selected");
        return selected ? selected.dataset.optionValue : null;
      });
    }

    function currentVariant() {
      const values = selectedOptionValues();
      return (
        product.variants.find((variant) =>
          values.every((value, i) => value === null || variant.options[i] === value),
        ) || product.variants[0]
      );
    }

    function planAllocation(variant, planId) {
      return (variant.selling_plan_allocations || []).find(
        (a) => a.selling_plan_id === planId || (a.selling_plan && a.selling_plan.id === planId),
      );
    }

    function currentMode() {
      const checked = modeInputs.find((input) => input.checked);
      return checked ? checked.value : "subscribe";
    }

    function setMode(mode) {
      modeInputs.forEach((input) => {
        input.checked = input.value === mode;
      });
    }

    function render() {
      const variant = currentVariant();
      const mode = currentMode();

      // Best-value badge reflects whichever plan genuinely has the deepest
      // discount for THIS variant, not a fixed plan -- discounts can vary by
      // tier and some variants may not have every plan's allocation.
      let bestDiscount = 0;
      Array.from(planSelect.options).forEach((option) => {
        const allocation = planAllocation(variant, Number(option.value));
        if (!allocation || !variant.price) return;
        const discount = Math.round((1 - allocation.price / variant.price) * 100);
        if (discount > bestDiscount) bestDiscount = discount;
      });

      const selectedPlanId = Number(planSelect.value);
      const selectedAllocation = planAllocation(variant, selectedPlanId);
      const selectedPrice = selectedAllocation ? selectedAllocation.price : variant.price;
      const selectedDiscount =
        selectedAllocation && variant.price
          ? Math.round((1 - selectedAllocation.price / variant.price) * 100)
          : 0;

      discountPercentEl.textContent = selectedDiscount > 0 ? `${selectedDiscount}%` : "";
      planPriceEl.textContent = formatMoney(selectedPrice, moneyFormat);
      if (selectedDiscount > 0) {
        comparePriceEl.textContent = formatMoney(variant.price, moneyFormat);
        comparePriceEl.hidden = false;
      } else {
        comparePriceEl.hidden = true;
      }

      if (bestValueBadgeEl) {
        const showBadge = settings.showBestValueBadge && bestDiscount > 0 && selectedDiscount === bestDiscount;
        bestValueBadgeEl.hidden = !showBadge;
      }

      if (onetimePriceEl) {
        onetimePriceEl.textContent = formatMoney(variant.price, moneyFormat);
      }

      if (mode === "subscribe") {
        const intervalLabel = planSelect.selectedOptions[0] ? planSelect.selectedOptions[0].textContent : "";
        submitBtn.textContent = `${settings.subscribeButtonLabel} — ${formatMoney(selectedPrice, moneyFormat)} / ${intervalLabel}`;
      } else {
        submitBtn.textContent = `${settings.oneTimeButtonLabel} — ${formatMoney(variant.price, moneyFormat)}`;
      }
    }

    optionEls.forEach((optionEl) => {
      optionEl.querySelectorAll("[data-option-value]").forEach((btn) => {
        btn.addEventListener("click", () => {
          optionEl
            .querySelectorAll("[data-option-value]")
            .forEach((sibling) => sibling.classList.remove("is-selected"));
          btn.classList.add("is-selected");
          render();
        });
      });
    });

    if (decreaseBtn && increaseBtn && quantityInput) {
      decreaseBtn.addEventListener("click", () => {
        quantityInput.value = Math.max(1, Number(quantityInput.value) - 1);
      });
      increaseBtn.addEventListener("click", () => {
        quantityInput.value = Number(quantityInput.value) + 1;
      });
    }

    planSelect.addEventListener("change", () => {
      setMode("subscribe");
      render();
    });
    modeInputs.forEach((input) => input.addEventListener("change", render));

    submitBtn.addEventListener("click", async () => {
      const variant = currentVariant();
      const quantity = quantityInput ? Math.max(1, Number(quantityInput.value)) : 1;
      const isSubscribing = currentMode() === "subscribe";

      const payload = {
        items: [
          {
            id: variant.id,
            quantity,
            ...(isSubscribing ? { selling_plan: Number(planSelect.value) } : {}),
          },
        ],
      };

      submitBtn.disabled = true;
      statusEl.textContent = "Adding to cart…";

      try {
        const response = await fetch("/cart/add.js", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => null);
          throw new Error((error && error.description) || "Couldn't add this to your cart.");
        }

        window.location.href = "/cart";
      } catch (error) {
        statusEl.textContent = error.message;
        submitBtn.disabled = false;
      }
    });

    render();
  }

  function initAll() {
    document.querySelectorAll("[data-subscription-widget]").forEach(initWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  // Re-init when a merchant adds/reconfigures the block in the theme editor.
  document.addEventListener("shopify:section:load", initAll);
})();
