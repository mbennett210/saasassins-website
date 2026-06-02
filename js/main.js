/* ═══════════════════════════════════════════════════════════
   SaaSassins — Shared JavaScript
   Navigation, scroll effects, interactive widgets.
   Zero dependencies. Vanilla ES.
   ═══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initScrollReveal();
  initScrollProgress();
  initFAQ();
  initCalculator();
  initCounters();
  initRipple();
  initContactForm();
  initDemoCarousel();
});

/* ── Navigation ── */
function initNav() {
  const nav    = document.querySelector('.nav');
  const toggle = document.querySelector('.nav-toggle');
  const links  = document.querySelector('.nav-links');
  if (!nav) return;

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        nav.classList.toggle('scrolled', window.scrollY > 40);
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
  nav.classList.toggle('scrolled', window.scrollY > 40);

  if (toggle && links) {
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('open');
      links.classList.toggle('open');
      document.body.style.overflow = links.classList.contains('open') ? 'hidden' : '';
    });
    links.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        toggle.classList.remove('open');
        links.classList.remove('open');
        document.body.style.overflow = '';
      });
    });
  }
}

/* ── Scroll Reveal ── */
function initScrollReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  els.forEach(el => observer.observe(el));
}

/* ── Scroll Progress Bar ── */
function initScrollProgress() {
  const bar = document.querySelector('.scroll-progress');
  if (!bar) return;
  window.addEventListener('scroll', () => {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress  = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    bar.style.width = progress + '%';
  }, { passive: true });
}

/* ── FAQ Accordion ── */
function initFAQ() {
  document.querySelectorAll('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item   = btn.closest('.faq-item');
      const answer = item.querySelector('.faq-a');
      const isOpen = item.classList.contains('open');

      document.querySelectorAll('.faq-item.open').forEach(open => {
        open.classList.remove('open');
        open.querySelector('.faq-a').style.maxHeight = '0';
      });

      if (!isOpen) {
        item.classList.add('open');
        answer.style.maxHeight = answer.scrollHeight + 'px';
      }
    });
  });
}

/* ── SaaS Spend Calculator ── */
function initCalculator() {
  const monthlySlider = document.getElementById('calc-monthly');
  const yearsSlider   = document.getElementById('calc-years');
  if (!monthlySlider || !yearsSlider) return;

  const monthlyVal = document.getElementById('calc-monthly-val');
  const yearsVal   = document.getElementById('calc-years-val');
  const theirCost  = document.getElementById('calc-theirs');
  const ourCost    = document.getElementById('calc-ours');
  const savings    = document.getElementById('calc-savings');

  function updateSliderTrack(slider) {
    const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.background = `linear-gradient(to right, var(--red-600) 0%, var(--red-500) ${pct}%, var(--dark-600) ${pct}%)`;
  }

  function update() {
    const monthly = parseInt(monthlySlider.value, 10);
    const years   = parseInt(yearsSlider.value, 10);

    monthlyVal.textContent = '$' + monthly.toLocaleString() + '/mo';
    yearsVal.textContent   = years + (years === 1 ? ' year' : ' years');

    updateSliderTrack(monthlySlider);
    updateSliderTrack(yearsSlider);

    // What they'd pay continuing on SaaS
    const totalTheirs = monthly * 12 * years;
    // Custom build estimate: $5k base + $60/mo infra
    const totalOurs   = 5000 + (60 * 12 * years);

    theirCost.textContent = '$' + totalTheirs.toLocaleString();
    ourCost.textContent   = '$' + totalOurs.toLocaleString();

    const saved = totalTheirs - totalOurs;
    savings.textContent = '$' + Math.max(0, saved).toLocaleString();
  }

  monthlySlider.addEventListener('input', update);
  yearsSlider.addEventListener('input', update);
  update();
}

/* ── Animated Counters ── */
function initCounters() {
  const counters = document.querySelectorAll('[data-count]');
  if (!counters.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  counters.forEach(el => observer.observe(el));
}

function animateCounter(el) {
  const target   = parseInt(el.dataset.count, 10);
  const prefix   = el.dataset.prefix || '';
  const suffix   = el.dataset.suffix || '';
  const duration = 2000;
  const start    = performance.now();

  function tick(now) {
    const elapsed  = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current  = Math.round(eased * target);
    el.textContent = prefix + current.toLocaleString() + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}


/* ── Button Ripple ── */
function initRipple() {
  document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', function (e) {
      const ripple = document.createElement('span');
      ripple.classList.add('ripple');
      const rect = this.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      ripple.style.width  = size + 'px';
      ripple.style.height = size + 'px';
      ripple.style.left   = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top    = (e.clientY - rect.top  - size / 2) + 'px';
      this.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  });
}

/* ── Demo Carousel ── */
function initDemoCarousel() {
  const track = document.getElementById('carouselTrack');
  if (!track) return;

  const slides = track.querySelectorAll('.carousel-slide');
  const tabs   = document.querySelectorAll('.carousel-tab');
  const dots   = document.querySelectorAll('.carousel-dot');
  let current  = 0;
  let autoTimer = null;

  function goTo(idx) {
    current = ((idx % slides.length) + slides.length) % slides.length;
    track.style.transform = `translateX(-${current * 100}%)`;
    tabs.forEach((t, i) => t.classList.toggle('active', i === current));
    dots.forEach((d, i) => d.classList.toggle('active', i === current));
  }

  // Tab + dot click
  tabs.forEach(t => t.addEventListener('click', () => { goTo(parseInt(t.dataset.slide)); resetAuto(); }));
  dots.forEach(d => d.addEventListener('click', () => { goTo(parseInt(d.dataset.slide)); resetAuto(); }));

  // Touch swipe
  let startX = 0, startY = 0, dragging = false;
  track.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; dragging = true; }, { passive: true });
  track.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      goTo(current + (dx < 0 ? 1 : -1));
      resetAuto();
    }
  }, { passive: true });

  // Auto-advance every 6s
  function startAuto() { autoTimer = setInterval(() => goTo(current + 1), 6000); }
  function resetAuto() { clearInterval(autoTimer); startAuto(); }
  startAuto();
}

/* ── Contact form (mailto fallback — no backend needed) ── */
function initContactForm() {
  const form = document.querySelector('form.contact-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const name    = (data.get('name')    || '').toString().trim();
    const email   = (data.get('email')   || '').toString().trim();
    const company = (data.get('company') || '').toString().trim();
    const message = (data.get('message') || '').toString().trim();

    const subject = encodeURIComponent(`Strike call inquiry from ${name || 'website'}`);
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\nCompany: ${company}\n\n${message}`
    );
    window.location.href = `mailto:hello@saasassins.com?subject=${subject}&body=${body}`;
  });
}


/* ── Calendly Integration ── */
function openCalendly() {
  const url = 'https://calendly.com/hello-saasassinsdev/strike-call-discovery';
  if (typeof Calendly !== 'undefined') {
    Calendly.initPopupWidget({ url });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return false;
}

/* ── Smooth scroll for anchor links ── */
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="#"]');
  if (!link) return;
  const href = link.getAttribute('href');
  if (href === '#' || href.length < 2) return;
  const target = document.querySelector(href);
  if (target) {
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
