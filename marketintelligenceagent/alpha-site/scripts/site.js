/**
#
# Copyright (c) 2026 majiklTrust Market Intelligence, LLC. All rights reserved.
#
# This file is part of Market Intelligence and contains proprietary and
# confidential information. Unauthorized copying, modification, distribution,
# or use of this file, via any medium, is strictly prohibited without the
# express written permission of the copyright holder.
#

**/

(function () {
  'use strict';

  

  var STATUS_ENDPOINT = '/auth/status';
  var PROBE_TIMEOUT_MS = 5000;
  var DEFAULT_DASHBOARD_URL = '/app';
  var DEFAULT_LOGIN_URL = '/auth/login';

  

  var ctas = document.querySelectorAll('.js-auth-cta');
  var greeting = document.getElementById('user-greeting');
  var banner = document.getElementById('degraded-banner');

  

    function probe() {
    if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
      
      return Promise.resolve({ state: 'unauth' });
    }

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, PROBE_TIMEOUT_MS);

    return fetch(STATUS_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        return { state: 'error' };
      }
      return res.json().then(function (body) {
        if (body && body.authenticated === true) {
          return { state: 'auth', user: body.user || {} };
        }
        return { state: 'unauth' };
      }).catch(function () {
        return { state: 'error' };
      });
    }).catch(function () {
      clearTimeout(timer);
      return { state: 'error' };
    });
  }

  

    function updateCtas(state) {
    for (var i = 0; i < ctas.length; i++) {
      var el = ctas[i];

      if (state === 'error') {
        el.removeAttribute('href');
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('tabindex', '-1');
        el.classList.add('is-disabled');
        continue;
      }

      
      el.removeAttribute('aria-disabled');
      el.removeAttribute('tabindex');
      el.classList.remove('is-disabled');

      if (state === 'auth') {
        el.setAttribute('href', el.dataset.hrefAuth || DEFAULT_DASHBOARD_URL);
      } else {
        el.setAttribute('href', DEFAULT_LOGIN_URL);
      }
    }
  }

    function showGreeting(user) {
    if (!greeting) return;
    if (!user) return;

    var label = '';
    if (typeof user.name === 'string' && user.name.length > 0) {
      label = user.name;
    } else if (typeof user.email === 'string' && user.email.length > 0) {
      label = user.email;
    }

    if (!label) return;

    var nameEl = greeting.querySelector('.user-name');
    if (nameEl) {
      nameEl.textContent = label;
    }
    greeting.hidden = false;
  }

  function showDegradedBanner() {
    if (banner) {
      banner.hidden = false;
    }
  }

  

  function apply(result) {
    if (result.state === 'error') {
      updateCtas('error');
      showDegradedBanner();
      return;
    }
    if (result.state === 'auth') {
      updateCtas('auth');
      showGreeting(result.user);
      return;
    }
    updateCtas('unauth');
  }

  function init() {
    probe().then(apply);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
