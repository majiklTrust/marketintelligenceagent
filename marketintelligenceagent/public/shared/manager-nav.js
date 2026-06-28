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
  var API = window.location.origin;
  var currentPath = window.location.pathname.replace(/\/+$/, '');

  var pages = [
    { path: '/app/topics', label: 'Topics', roles: ['owner', 'editor'] },
    { path: '/app/feeds', label: 'Feeds', roles: ['owner', 'editor'] },
    { path: '/app/admin', label: 'Manage Users', roles: ['owner'] }
  ];

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function renderNav(role) {
    var container = document.getElementById('manager-nav');
    if (!container) return;

    var html = '<nav class="manager-nav">';
    html += '<a href="/app" class="manager-nav-link">← Dashboard</a>';

    pages.forEach(function (page) {
      if (page.roles.indexOf(role) === -1) return;

      var isActive = currentPath === page.path;
      if (isActive) {
        html += '<span class="manager-nav-link manager-nav-active">' + esc(page.label) + '</span>';
      } else {
        html += '<a href="' + page.path + '/" class="manager-nav-link">' + esc(page.label) + '</a>';
      }
    });

    html += '</nav>';
    container.innerHTML = html;
  }

  
  fetch(API + '/api/status', { credentials: 'include', headers: { 'Accept': 'application/json' } })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.user && data.user.role) {
        renderNav(data.user.role);
      }
    })
    .catch(function () {  });
})();
