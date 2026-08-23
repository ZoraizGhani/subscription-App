(function () {
  function formatMoney(cents, format) {
    // `format` normally comes from shop.money_format (passed in via the
    // settings JSON, always available server-side); window.Shopify.money_format
    // is only a last-resort fallback since not every theme sets that legacy
    // global. Falls back to a plain decimal if neither is available.
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
    const flavorSwatchGrid = root.querySelector('[data-option-index="0"]');
    const selectedFlavorValueEl = root.querySelector("[data-selected-flavor-value]");
    const quantityInput = root.querySelector("[data-quantity-input]");
    const decreaseBtn = root.querySelector("[data-quantity-decrease]");
    const increaseBtn = root.querySelector("[data-quantity-increase]");
    const submitBtn = root.querySelector("[data-add-to-cart]");
    const statusEl = root.querySelector("[data-status]");

    const bundleCards = Array.from(root.querySelectorAll("[data-bundle-card]"));
    const bundleRadios = Array.from(root.querySelectorAll("[data-plan-radio]"));

    const moneyFormat = settings.moneyFormat || (window.Shopify && window.Shopify.money_format);

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

    function planDiscount(variant, planId) {
      const allocation = planAllocation(variant, planId);
      if (!allocation || !variant.price) return { price: variant.price, discount: 0 };
      return { price: allocation.price, discount: Math.round((1 - allocation.price / variant.price) * 100) };
    }

    function selectedPlanId() {
      const checked = bundleRadios.find((input) => input.checked);
      return checked ? Number(checked.value) : bundleRadios[0] ? Number(bundleRadios[0].value) : null;
    }

    function render() {
      const variant = currentVariant();

      // Every bundle card prices and discounts itself independently, so the
      // "Best value" badge can mark whichever plan is objectively the best
      // deal rather than only reacting to whatever's currently selected.
      let bestCard = null;
      let bestDiscount = -1;
      bundleCards.forEach((card) => {
        const radio = card.querySelector("[data-plan-radio]");
        const priceEl = card.querySelector("[data-bundle-price]");
        const { price, discount } = planDiscount(variant, Number(radio.value));
        if (priceEl) priceEl.textContent = formatMoney(price, moneyFormat);
        if (discount > bestDiscount) {
          bestDiscount = discount;
          bestCard = card;
        }
      });

      bundleCards.forEach((card) => {
        const badgeEl = card.querySelector("[data-bundle-best-badge]");
        if (!badgeEl) return;
        badgeEl.hidden = !(settings.showBestValueBadge && bestDiscount > 0 && card === bestCard);
      });

      const planId = selectedPlanId();
      const { price: selectedPrice } = planDiscount(variant, planId);
      const selectedCard = bundleCards.find((card) => Number(card.querySelector("[data-plan-radio]").value) === planId);
      const label = selectedCard ? selectedCard.querySelector(".subscription-widget__bundle-title").textContent : "";
      submitBtn.textContent = `${settings.subscribeButtonLabel} — ${formatMoney(selectedPrice, moneyFormat)} / ${label}`;
    }

    optionEls.forEach((optionEl) => {
      optionEl.querySelectorAll("[data-option-value]").forEach((btn) => {
        btn.addEventListener("click", () => {
          optionEl
            .querySelectorAll("[data-option-value]")
            .forEach((sibling) => sibling.classList.remove("is-selected"));
          btn.classList.add("is-selected");
          if (optionEl === flavorSwatchGrid && selectedFlavorValueEl) {
            selectedFlavorValueEl.textContent = btn.dataset.swatchLabel || btn.dataset.optionValue;
          }
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

    bundleRadios.forEach((input) => input.addEventListener("change", render));

    submitBtn.addEventListener("click", async () => {
      const variant = currentVariant();
      const quantity = quantityInput ? Math.max(1, Number(quantityInput.value)) : 1;

      const payload = {
        items: [
          {
            id: variant.id,
            quantity,
            selling_plan: selectedPlanId(),
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
