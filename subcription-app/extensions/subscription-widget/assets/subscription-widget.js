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

    const optionEls = Array.from(root.querySelectorAll("[data-option-index]"));
    const quantityInput = root.querySelector("[data-quantity-input]");
    const decreaseBtn = root.querySelector("[data-quantity-decrease]");
    const increaseBtn = root.querySelector("[data-quantity-increase]");
    const planInputs = Array.from(root.querySelectorAll("[data-plan-option]"));
    const submitBtn = root.querySelector("[data-add-to-cart]");
    const statusEl = root.querySelector("[data-status]");

    const moneyFormat = window.Shopify && window.Shopify.money_format;

    function selectedOptionValues() {
      return optionEls.map((optionEl) => {
        const selected = optionEl.querySelector(".subscription-widget__option-value.is-selected");
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

    function updatePrices() {
      const variant = currentVariant();

      planInputs.forEach((input) => {
        const priceEl = input.closest(".subscription-widget__plan").querySelector("[data-plan-price]");
        if (!input.value) {
          priceEl.textContent = formatMoney(variant.price, moneyFormat);
          return;
        }
        const planId = Number(input.value);
        const allocation = (variant.selling_plan_allocations || []).find(
          (a) => a.selling_plan_id === planId || (a.selling_plan && a.selling_plan.id === planId),
        );
        priceEl.textContent = formatMoney(
          allocation ? allocation.price : variant.price,
          moneyFormat,
        );
      });
    }

    optionEls.forEach((optionEl) => {
      optionEl.querySelectorAll(".subscription-widget__option-value").forEach((btn) => {
        btn.addEventListener("click", () => {
          optionEl
            .querySelectorAll(".subscription-widget__option-value")
            .forEach((sibling) => sibling.classList.remove("is-selected"));
          btn.classList.add("is-selected");
          updatePrices();
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

    submitBtn.addEventListener("click", async () => {
      const variant = currentVariant();
      const selectedPlan = planInputs.find((input) => input.checked);
      const quantity = quantityInput ? Math.max(1, Number(quantityInput.value)) : 1;

      const payload = {
        items: [
          {
            id: variant.id,
            quantity,
            ...(selectedPlan && selectedPlan.value
              ? { selling_plan: Number(selectedPlan.value) }
              : {}),
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

    updatePrices();
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