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
    const submitBtn = root.querySelector("[data-add-to-cart]");
    const statusEl = root.querySelector("[data-status]");

    const bundleCards = Array.from(root.querySelectorAll("[data-bundle-card]"));
    const bundleRadios = Array.from(root.querySelectorAll("[data-plan-radio]"));

    const summarySubmitBtn = root.querySelector("[data-add-to-cart-summary]");
    const summaryTitleEl = root.querySelector("[data-summary-title]");
    const summarySaveEl = root.querySelector("[data-summary-save]");
    const summaryPriceEl = root.querySelector("[data-summary-price]");
    const summaryCompareEl = root.querySelector("[data-summary-compare]");
    const summaryBillingEl = root.querySelector("[data-summary-billing]");
    const summaryPerServingEl = root.querySelector("[data-summary-per-serving]");
    const summaryOnetimeCompareEl = root.querySelector("[data-summary-onetime-compare]");
    const summaryOnetimePriceEl = root.querySelector("[data-summary-onetime-price]");
    const summaryOnetimePerDayEl = root.querySelector("[data-summary-onetime-perday]");
    const onetimeBtn = root.querySelector("[data-add-to-cart-onetime]");
    const summaryBenefitsEls = Array.from(root.querySelectorAll("[data-summary-benefits-plan]"));
    const summaryBannerEls = Array.from(root.querySelectorAll("[data-summary-banner-plan]"));

    const stickyBar = root.querySelector("[data-sticky-bar]");
    const stickyImage = root.querySelector("[data-sticky-image]");
    const stickyPlanTrigger = root.querySelector("[data-sticky-plan-trigger]");
    const stickyPlanLabel = root.querySelector("[data-sticky-plan-label]");
    const stickyPlanSub = root.querySelector("[data-sticky-plan-sub]");
    const stickyPlanList = root.querySelector("[data-sticky-plan-list]");
    const stickyPlanOptions = Array.from(root.querySelectorAll("[data-sticky-plan-option]"));
    const stickySubmitBtn = root.querySelector("[data-sticky-add-to-cart]");
    const stickySubmitLabel = root.querySelector("[data-sticky-submit-label]");

    // Moved to a direct child of <body> so it always stays pinned to the
    // viewport -- theme sections often wrap content in an ancestor with a
    // transform/filter/will-change (common for scroll animations), which
    // silently turns `position: fixed` into something scoped to that
    // ancestor instead of the real viewport.
    if (stickyBar) document.body.appendChild(stickyBar);

    const moneyFormat = settings.moneyFormat || (window.Shopify && window.Shopify.money_format);

    // Set by render() every time the selected plan changes -- the add-to-
    // cart buttons read these at click time rather than recomputing them,
    // since they need the exact same values render() already derived.
    let currentPlanDays = 0;
    let currentPlanQuantity = 1;

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
        const { discount } = planDiscount(variant, Number(radio.value));
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
      const { price: selectedPrice, discount: selectedDiscount } = planDiscount(variant, planId);

      // Each plan gets its own benefits richtext and banner text (configured
      // per bundle slot in the theme editor) -- only the one matching the
      // selected plan is shown, the rest stay in the DOM but hidden.
      summaryBenefitsEls.forEach((el) => {
        el.hidden = Number(el.dataset.summaryBenefitsPlan) !== planId;
      });
      summaryBannerEls.forEach((el) => {
        el.hidden = Number(el.dataset.summaryBannerPlan) !== planId;
      });

      const selectedRadio = bundleRadios.find((input) => Number(input.value) === planId);
      const selectedCard = selectedRadio ? selectedRadio.closest("[data-bundle-card]") : null;
      const label = selectedCard ? selectedCard.querySelector(".subscription-widget__bundle-title").textContent : "";
      submitBtn.textContent = `${settings.subscribeButtonLabel} — ${formatMoney(selectedPrice, moneyFormat)} / ${label}`;

      // Assumes one unit ships per day (true for this app's only product so
      // far); days doubles as both the serving count and the quantity, so
      // "per serving" and "per day" below are the same number by design,
      // not a coincidence.
      const days = selectedRadio ? Number(selectedRadio.dataset.days) || 0 : 0;
      currentPlanDays = days;
      currentPlanQuantity = selectedRadio ? Math.max(1, Number(selectedRadio.dataset.quantity) || 1) : 1;
      const perServing = days ? selectedPrice / days : selectedPrice;

      // Sticky bar mirrors whichever plan/variant is selected above -- image,
      // plan label and price all recompute here so picking a plan/flavor in
      // the main widget updates it too, not just the reverse (see the sticky
      // option click handler below for that direction).
      if (stickyImage) {
        // product.featured_image serializes as a plain URL string; a
        // variant's featured_image serializes as an object with its own
        // .src -- not the same shape, so each needs its own extraction.
        const imageSrc =
          product.featured_image || (variant.featured_image && variant.featured_image.src);
        if (imageSrc) {
          stickyImage.src = imageSrc;
          stickyImage.alt = product.title;
          stickyImage.hidden = false;
        } else {
          stickyImage.hidden = true;
        }
      }
      if (stickyPlanLabel) {
        stickyPlanLabel.textContent =
          selectedDiscount > 0 ? `${days}-Day Supply (Save ${selectedDiscount}%)` : `${days}-Day Supply`;
      }
      if (stickyPlanSub) stickyPlanSub.textContent = `${formatMoney(perServing, moneyFormat)} USD / serving`;
      if (stickySubmitLabel) {
        stickySubmitLabel.textContent = `${settings.subscribeButtonLabel} - ${formatMoney(selectedPrice, moneyFormat)}`;
      }

      stickyPlanOptions.forEach((optionBtn) => {
        const optPlanId = Number(optionBtn.dataset.planId);
        const isSelected = optPlanId === planId;
        const { price: optPrice, discount: optDiscount } = planDiscount(variant, optPlanId);
        const optRadio = bundleRadios.find((input) => Number(input.value) === optPlanId);
        const optCard = optRadio ? optRadio.closest("[data-bundle-card]") : null;
        const optTitle = optCard
          ? optCard.querySelector(".subscription-widget__bundle-title").textContent
          : "";
        const optDays = optRadio ? Number(optRadio.dataset.days) || 0 : 0;
        const optPerServing = optDays ? optPrice / optDays : optPrice;

        const labelEl = optionBtn.querySelector("[data-option-label]");
        const subEl = optionBtn.querySelector("[data-option-sub]");
        if (labelEl) {
          labelEl.textContent =
            optDiscount > 0 ? `${optTitle} Supply (Save ${optDiscount}%)` : `${optTitle} Supply`;
        }
        if (subEl) subEl.textContent = `${formatMoney(optPerServing, moneyFormat)} USD / serving`;
        optionBtn.classList.toggle("is-selected", isSelected);
        optionBtn.setAttribute("aria-selected", String(isSelected));
      });

      // Order summary card -- mirrors whichever plan is selected above.
      if (summaryTitleEl) summaryTitleEl.textContent = `${days}-Day Supply`;
      if (summarySaveEl) {
        summarySaveEl.hidden = selectedDiscount <= 0;
        summarySaveEl.textContent = selectedDiscount > 0 ? `SAVE ${selectedDiscount}%` : "";
      }

      // A plan's sticker price is for its whole multi-day cycle, not a
      // month -- normalize to a monthly-equivalent for display only when
      // the cycle is at least a month; a handful of days doesn't convert
      // meaningfully into "per month".
      const monthsInCycle = days / 30;
      const displayPrice = monthsInCycle >= 1 ? selectedPrice / monthsInCycle : selectedPrice;
      const displayCompare = monthsInCycle >= 1 ? variant.price / monthsInCycle : variant.price;
      if (summaryPriceEl) summaryPriceEl.textContent = formatMoney(displayPrice, moneyFormat);
      if (summaryCompareEl) {
        summaryCompareEl.hidden = selectedDiscount <= 0;
        summaryCompareEl.textContent = selectedDiscount > 0 ? `${formatMoney(displayCompare, moneyFormat)}/mo` : "";
      }

      const weeks = days ? Math.round(days / 7) || 1 : 0;
      if (summaryBillingEl) {
        summaryBillingEl.textContent = `Billed ${formatMoney(selectedPrice, moneyFormat)} USD every ${weeks} week${weeks === 1 ? "" : "s"}`;
      }
      if (summaryPerServingEl) summaryPerServingEl.textContent = `${formatMoney(perServing, moneyFormat)} USD / SERVING`;

      // One-time comparison: the same quantity (one unit per day) at the
      // plain, undiscounted per-unit price -- what it would cost without
      // subscribing at all.
      const oneTimeTotal = days ? variant.price * days : variant.price;
      if (summaryOnetimeCompareEl) {
        summaryOnetimeCompareEl.hidden = selectedDiscount <= 0;
        summaryOnetimeCompareEl.textContent = selectedDiscount > 0 ? formatMoney(oneTimeTotal, moneyFormat) : "";
      }
      if (summaryOnetimePriceEl) summaryOnetimePriceEl.textContent = formatMoney(selectedPrice, moneyFormat);
      if (summaryOnetimePerDayEl) summaryOnetimePerDayEl.textContent = formatMoney(perServing, moneyFormat);
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

    bundleRadios.forEach((input) => input.addEventListener("change", render));

    // Shared by the main submit button, the order summary card's own "Add
    // to cart" button, and its "One-time purchase" button -- all three are
    // entry points to the same cart, not independent flows. oneTime skips
    // selling_plan entirely (a real one-time purchase, not a subscription)
    // and uses the selected plan's day count as the quantity, matching the
    // total price shown next to it. A subscription uses whatever quantity
    // the merchant configured for that specific plan in the app's admin
    // (Selling Plan Settings), which can differ per plan -- not always 1.
    async function addToCart({ oneTime } = {}) {
      const variant = currentVariant();
      const quantity = oneTime ? Math.max(1, currentPlanDays) : currentPlanQuantity;

      const payload = {
        items: [
          {
            id: variant.id,
            quantity,
            ...(oneTime ? {} : { selling_plan: selectedPlanId() }),
          },
        ],
      };

      submitBtn.disabled = true;
      if (summarySubmitBtn) summarySubmitBtn.disabled = true;
      if (onetimeBtn) onetimeBtn.disabled = true;
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
        if (summarySubmitBtn) summarySubmitBtn.disabled = false;
        if (onetimeBtn) onetimeBtn.disabled = false;
      }
    }

    submitBtn.addEventListener("click", () => addToCart());
    if (summarySubmitBtn) summarySubmitBtn.addEventListener("click", () => addToCart());
    if (onetimeBtn) onetimeBtn.addEventListener("click", () => addToCart({ oneTime: true }));
    if (stickySubmitBtn) stickySubmitBtn.addEventListener("click", () => addToCart());

    function closeStickyPlanList() {
      if (!stickyPlanList || stickyPlanList.hidden) return;
      stickyPlanList.hidden = true;
      if (stickyPlanTrigger) stickyPlanTrigger.setAttribute("aria-expanded", "false");
    }

    if (stickyPlanTrigger && stickyPlanList) {
      stickyPlanTrigger.addEventListener("click", () => {
        const isOpen = !stickyPlanList.hidden;
        stickyPlanList.hidden = isOpen;
        stickyPlanTrigger.setAttribute("aria-expanded", String(!isOpen));
      });
      document.addEventListener("click", (event) => {
        if (!stickyBar.contains(event.target)) closeStickyPlanList();
      });
    }

    // Picking a plan here is the reverse sync direction: check the matching
    // bundle radio and re-render, which updates the main widget's bundle
    // grid/order summary exactly as if that card had been clicked directly.
    stickyPlanOptions.forEach((optionBtn) => {
      optionBtn.addEventListener("click", () => {
        const radio = bundleRadios.find((input) => input.value === optionBtn.dataset.planId);
        if (radio && !radio.checked) {
          radio.checked = true;
          render();
        }
        closeStickyPlanList();
      });
    });

    // Shows the sticky bar once the main order summary's own submit button
    // scrolls out of view, hides it again once that button is back on screen.
    if (stickyBar && summarySubmitBtn && "IntersectionObserver" in window) {
      const stickyBarObserver = new IntersectionObserver(
        ([entry]) => {
          stickyBar.hidden = entry.isIntersecting;
        },
        { threshold: 0 },
      );
      stickyBarObserver.observe(summarySubmitBtn);
    }

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
