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
    const flavorSwatches = Array.from(root.querySelectorAll("[data-flavor-swatch]"));
    const flavorRemainingEl = root.querySelector("[data-flavor-remaining]");
    const flavorSelectedEl = root.querySelector("[data-flavor-selected]");
    const submitBtn = root.querySelector("[data-add-to-cart]");
    const statusEl = root.querySelector("[data-status]");

    // variantId (string) -> quantity. When a plan ships more than one unit,
    // this is how that quantity gets split across flavors (e.g. 3 bottles =
    // 2 Sour Green Apple + 1 Blood Orange) instead of always being one
    // flavor times the quantity.
    const flavorQuantities = {};

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

    // Moved to a direct child of <html> (not <body>) so it always stays
    // pinned to the real viewport. Many themes set a transform/filter/
    // will-change on <body> itself (common for slide-out mobile nav
    // drawers), which silently turns `position: fixed` into something
    // scoped to that ancestor instead of the viewport -- a fixed element
    // has to sit outside <body> entirely to be immune to that, since
    // <html> is essentially never transformed.
    if (stickyBar) document.documentElement.appendChild(stickyBar);

    const moneyFormat = settings.moneyFormat || (window.Shopify && window.Shopify.money_format);

    // Set by render() every time the selected plan changes -- the add-to-
    // cart buttons read these at click time rather than recomputing them,
    // since they need the exact same values render() already derived.
    let currentPlanQuantity = 1;
    let lastFlavorPlanQuantity = null;

    function selectedOptionValues() {
      return optionEls.map((optionEl) => {
        const selected = optionEl.querySelector("[data-option-value].is-selected");
        return selected ? selected.dataset.optionValue : null;
      });
    }

    function flavorTotalSelected() {
      return flavorSwatches.reduce((sum, el) => sum + (flavorQuantities[el.dataset.variantId] || 0), 0);
    }

    // Resets the mix whenever the selected plan's quantity changes -- always
    // back to empty (no flavor pre-filled), so the dots start blank on page
    // load and the customer builds the mix themselves by tapping flavors.
    function resetFlavorQuantities() {
      flavorSwatches.forEach((el) => {
        flavorQuantities[el.dataset.variantId] = 0;
      });
    }

    function currentVariant() {
      // Flavor is priced off whichever swatch currently has quantity > 0 --
      // any of them is fine for pricing since same-product flavors share a
      // price; this takes priority over the generic option-matching below
      // since flavor swatches no longer use the single-select is-selected
      // pattern that drives it.
      if (flavorSwatches.length) {
        const active = flavorSwatches.find((el) => (flavorQuantities[el.dataset.variantId] || 0) > 0) || flavorSwatches[0];
        const variant = product.variants.find((v) => String(v.id) === active.dataset.variantId);
        if (variant) return variant;
      }
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

      // `days` is the delivery cadence ("every N days"), purely a scheduling
      // concept -- it does NOT necessarily match how many servings actually
      // ship. That's `count` (the plan's own "Count" option, e.g. a 30-count
      // bottle), which is what per-serving/per-day pricing has to divide by.
      const days = selectedRadio ? Number(selectedRadio.dataset.days) || 0 : 0;
      const count = selectedRadio ? Number(selectedRadio.dataset.count) || days : days;
      currentPlanQuantity = selectedRadio ? Math.max(1, Number(selectedRadio.dataset.quantity) || 1) : 1;
      // A plan-quantity change (including the very first render) resets the
      // flavor mix -- all of it defaults back onto the first flavor, and the
      // customer redistributes from there via the +/- steppers below.
      if (flavorSwatches.length && currentPlanQuantity !== lastFlavorPlanQuantity) {
        lastFlavorPlanQuantity = currentPlanQuantity;
        resetFlavorQuantities();
      }
      // selectedPrice/variant.price are both per single variant unit --
      // multiply by quantity (how many units this plan actually ships) to
      // get the real total, then divide by count (total servings) for the
      // per-serving figure. A 3-quantity plan bills 3x the per-unit price.
      const totalPrice = selectedPrice * currentPlanQuantity;
      const perServing = count ? totalPrice / count : totalPrice;

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
        stickySubmitLabel.textContent = `${settings.subscribeButtonLabel} - ${formatMoney(totalPrice, moneyFormat)}`;
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
        const optCount = optRadio ? Number(optRadio.dataset.count) || optDays : optDays;
        const optQuantity = optRadio ? Math.max(1, Number(optRadio.dataset.quantity) || 1) : 1;
        const optPerServing = optCount ? (optPrice * optQuantity) / optCount : optPrice * optQuantity;

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

      // The headline price is per single unit -- the variant's own original
      // price as the compare-at, and Shopify's own selling-plan-discounted
      // price (already the variant price with the plan's %-off applied) as
      // the sale price. The full quantity-scaled total lives on the Billed
      // line below instead of being duplicated up here.
      if (summaryPriceEl) summaryPriceEl.textContent = formatMoney(selectedPrice, moneyFormat);
      if (summaryCompareEl) {
        summaryCompareEl.hidden = selectedDiscount <= 0;
        summaryCompareEl.textContent = selectedDiscount > 0 ? `${formatMoney(variant.price, moneyFormat)}/month` : "";
      }

      const weeks = days ? Math.round(days / 7) || 1 : 0;
      if (summaryBillingEl) {
        summaryBillingEl.textContent = `Billed ${formatMoney(totalPrice, moneyFormat)} USD every ${weeks} week${weeks === 1 ? "" : "s"}`;
      }
      if (summaryPerServingEl) summaryPerServingEl.textContent = `${formatMoney(perServing, moneyFormat)} USD / SERVING`;

      // A one-time purchase skips the selling plan entirely, so it's priced
      // off the variant's own price/compare-at price -- not the subscription
      // discount (`selectedPrice`), which only applies when actually
      // subscribing. This headline number is always a single unit's price
      // (a "from $X" tag), independent of how many flavors/units addToCart()
      // actually adds to the cart for the one-time mix. Show the
      // strikethrough only when the variant genuinely has a compare-at price
      // higher than its price; otherwise just the price.
      const oneTimePrice = variant.price;
      const oneTimeCompare = variant.compare_at_price;
      const oneTimeHasCompare = Boolean(oneTimeCompare) && oneTimeCompare > oneTimePrice;
      if (summaryOnetimeCompareEl) {
        summaryOnetimeCompareEl.hidden = !oneTimeHasCompare;
        summaryOnetimeCompareEl.textContent = oneTimeHasCompare ? formatMoney(oneTimeCompare, moneyFormat) : "";
      }
      if (summaryOnetimePriceEl) summaryOnetimePriceEl.textContent = formatMoney(oneTimePrice, moneyFormat);
      // Per-day price is a constant property of a single unit (each one is a
      // fixed 30-day supply) -- buying more units doesn't change the price
      // per day, so this divides the single-unit price, not the quantity-
      // scaled total.
      if (summaryOnetimePerDayEl) summaryOnetimePerDayEl.textContent = formatMoney(variant.price / 30, moneyFormat);

      updateFlavorUI();
    }

    // Compact row of removable chips below the grid, one per selected UNIT
    // (not deduped by flavor) -- a 3-quantity bundle with all 3 on one
    // flavor shows 3 chips, not 1 chip with a "3" badge, so the row always
    // mirrors the bundle's quantity. Rebuilt from flavorSwatches/
    // flavorQuantities on every render rather than diffed, since the whole
    // row is small and selection changes infrequently.
    function updateFlavorSelectedRow() {
      if (!flavorSelectedEl) return;
      const units = [];
      flavorSwatches.forEach((el) => {
        const qty = flavorQuantities[el.dataset.variantId] || 0;
        for (let n = 0; n < qty; n++) units.push(el);
      });
      flavorSelectedEl.hidden = units.length === 0;
      flavorSelectedEl.innerHTML = "";
      units.forEach((el) => {
        const variantId = el.dataset.variantId;
        const label = el.dataset.swatchLabel || "";
        const sourceImg = el.querySelector(".subscription-widget__swatch-image img");

        const chip = document.createElement("div");
        chip.className = "subscription-widget__flavor-chip";

        const imageWrap = document.createElement("span");
        imageWrap.className = "subscription-widget__flavor-chip-image";
        if (sourceImg) imageWrap.appendChild(sourceImg.cloneNode(true));
        chip.appendChild(imageWrap);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "subscription-widget__flavor-chip-remove";
        removeBtn.setAttribute("aria-label", `Remove ${label}`);
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", () => {
          const current = flavorQuantities[variantId] || 0;
          flavorQuantities[variantId] = Math.max(0, current - 1);
          render();
        });
        chip.appendChild(removeBtn);

        flavorSelectedEl.appendChild(chip);
      });
    }

    // Reflects flavorQuantities in the DOM: each swatch's dot row and its
    // "+" affordance's disabled state (can't push the total over the plan's
    // allowed quantity), the chip summary row, and the "N of M selected"
    // progress line.
    function updateFlavorUI() {
      if (!flavorSwatches.length) return;
      const sum = flavorTotalSelected();
      flavorSwatches.forEach((el) => {
        const qty = flavorQuantities[el.dataset.variantId] || 0;
        el.classList.toggle("is-selected", qty > 0);
        const plusBtn = el.querySelector("[data-qty-plus]");
        if (plusBtn) plusBtn.disabled = sum >= currentPlanQuantity;

        // One dot per unit the selected plan ships, filling in left-to-right
        // up to this swatch's own quantity -- rebuilt every render since
        // currentPlanQuantity can change between renders (switching bundles).
        const dotsEl = el.querySelector("[data-qty-dots]");
        if (dotsEl) {
          dotsEl.innerHTML = "";
          for (let i = 0; i < currentPlanQuantity; i++) {
            const dot = document.createElement("span");
            dot.className =
              "subscription-widget__swatch-dot" + (i < qty ? " is-filled" : "");
            dotsEl.appendChild(dot);
          }
        }
      });
      updateFlavorSelectedRow();
      if (flavorRemainingEl) {
        flavorRemainingEl.textContent = `${sum}/${currentPlanQuantity} selected`;
        flavorRemainingEl.classList.toggle("is-incomplete", sum !== currentPlanQuantity);
      }

      // Subscription add-to-cart entry points stay disabled until the flavor
      // mix adds up to exactly what the selected bundle's quantity calls for
      // -- addToCart() itself still guards this too, but disabling the
      // buttons makes the requirement visible before the customer even
      // tries. The one-time-purchase button is exempt: it always buys a
      // single unit regardless of the mix, so it's never gated by it.
      const mixValid = sum === currentPlanQuantity;
      submitBtn.disabled = !mixValid;
      if (summarySubmitBtn) summarySubmitBtn.disabled = !mixValid;
      if (stickySubmitBtn) stickySubmitBtn.disabled = !mixValid;

      // A disabled button never fires a click, so addToCart()'s own guard
      // message would never actually show -- this is the message's real
      // home, shown proactively instead of only after a (now-impossible)
      // click attempt.
      if (!mixValid) {
        statusEl.textContent = `Select ${currentPlanQuantity} total across flavors before adding to cart.`;
        statusEl.classList.add("is-error");
      } else if (statusEl.classList.contains("is-error")) {
        statusEl.textContent = "";
        statusEl.classList.remove("is-error");
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

    // Tapping anywhere on a flavor tile adds one unit to it -- the top-right
    // "+" is just a visual affordance inside the tile, not a separate
    // control (a click on it bubbles up to this same handler). Clamped so
    // the total across all flavors never exceeds the selected plan's
    // quantity; the same flavor can be picked more than once. Removing a
    // unit happens from the selected-flavor chip row below instead of here.
    flavorSwatches.forEach((el) => {
      const variantId = el.dataset.variantId;
      el.addEventListener("click", () => {
        if (flavorTotalSelected() >= currentPlanQuantity) return;
        flavorQuantities[variantId] = (flavorQuantities[variantId] || 0) + 1;
        render();
      });
    });

    bundleRadios.forEach((input) => input.addEventListener("change", render));

    // Shared by the main submit button, the order summary card's own "Add
    // to cart" button, and its "One-time purchase" button -- all three are
    // entry points to the same cart, not independent flows. A subscription
    // uses whatever quantity the merchant configured for that specific plan
    // in the app's admin (Selling Plan Settings), split across the chosen
    // flavor mix. A one-time purchase mirrors that same flavor mix (3
    // flavors selected -> 3 units split across them, 1 selected -> 1 unit)
    // but with no selling_plan attached and no requirement that the mix add
    // up to the plan's quantity -- it's just "buy exactly what's currently
    // picked," not a scaled-down bundle.
    async function addToCart({ oneTime } = {}) {
      let items;
      if (flavorSwatches.length) {
        const selectedItems = flavorSwatches
          .map((el) => ({ id: Number(el.dataset.variantId), quantity: flavorQuantities[el.dataset.variantId] || 0 }))
          .filter((item) => item.quantity > 0);

        if (oneTime) {
          if (selectedItems.length === 0) {
            statusEl.textContent = "Select at least one flavor before adding to cart.";
            statusEl.classList.add("is-error");
            return;
          }
          items = selectedItems;
        } else {
          // One cart line item per flavor with quantity > 0 (each is a
          // different variant, so they can't be combined into a single line
          // the way one flavor at quantity N could be). Block the submit
          // entirely if the mix doesn't add up to what the plan allows --
          // the same total the "N of M selected" progress line shows.
          if (flavorTotalSelected() !== currentPlanQuantity) {
            statusEl.textContent = `Select ${currentPlanQuantity} total across flavors before adding to cart.`;
            statusEl.classList.add("is-error");
            return;
          }
          const planId = selectedPlanId();
          items = selectedItems.map((item) => ({ ...item, selling_plan: planId }));
        }
      } else if (oneTime) {
        items = [{ id: currentVariant().id, quantity: 1 }];
      } else {
        items = [{ id: currentVariant().id, quantity: currentPlanQuantity, selling_plan: selectedPlanId() }];
      }

      const payload = { items };

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

    // Shows the sticky bar only once the whole subscription widget has
    // scrolled out of view, hides it again as soon as any part of the
    // widget is back on screen. Watches `root` itself (not just the order
    // summary's submit button) so the sticky bar stays hidden the entire
    // time the widget -- flavors, bundles, order summary -- is still
    // visible, not just while that one button is.
    if (stickyBar && "IntersectionObserver" in window) {
      const stickyBarObserver = new IntersectionObserver(
        ([entry]) => {
          stickyBar.hidden = entry.isIntersecting;
        },
        { threshold: 0 },
      );
      stickyBarObserver.observe(root);
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
