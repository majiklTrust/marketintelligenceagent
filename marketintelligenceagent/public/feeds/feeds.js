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

  function $(id) { return document.getElementById(id); }

  function showMessage(text, type) {
    var el = $('message');
    el.innerHTML = '<div class="msg msg-' + type + '">' + esc(text) + '</div>';
    setTimeout(function () { el.innerHTML = ''; }, 5000);
  }

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return 'never';
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  

  function checkAccess() {
    return fetch(API + '/api/status', { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var user = data.user;
        if (!user) return false;
        if (user.role !== 'owner' && user.role !== 'editor') return false;
        return true;
      })
      .catch(function () { return false; });
  }

  

  function renderFeedCard(f) {
    var cardClass = f.is_catchall ? 'feed-card catchall' : 'feed-card topic-specific';
    var html = '<div class="' + cardClass + '">';

    
    html += '<div class="feed-header">';
    html += '<span class="feed-name">' + esc(f.name) + '</span>';
    html += '<span>';
    if (f.is_catchall) html += '<span class="badge badge-catchall">catchall</span> ';
    html += '<span class="badge badge-tier">' + esc(f.tier) + '</span> ';
    if (!f.enabled) html += '<span class="badge badge-disabled">disabled</span>';
    html += '</span>';
    html += '</div>';

    
    html += '<div class="feed-url">' + esc(f.url) + '</div>';

    
    if (f.feed_description) {
      html += '<div class="feed-desc">' + esc(f.feed_description) + '</div>';
    }

    
    html += '<div class="feed-stats">';
    html += '<span class="stat"><strong>' + f.recent_articles + '</strong> articles (20d)</span>';
    html += '<span class="stat">Refresh: <strong>' + f.refresh_minutes + 'min</strong></span>';
    html += '<span class="stat">Polled: <strong>' + timeAgo(f.last_polled_at) + '</strong></span>';
    html += '</div>';

    
    if (!f.is_catchall && f.topics && f.topics.length > 0) {
      html += '<div style="margin-top:0.4rem;">';
      f.topics.forEach(function (t) {
        html += '<span class="badge badge-topic">' + esc(t.name) + '</span>';
      });
      html += '</div>';
    }

    
    var cats = f.feed_categories || [];
    if (cats.length > 0) {
      html += '<div class="categories">';
      cats.slice(0, 8).forEach(function (c) {
        html += '<span class="badge badge-tier" style="background:#f3e5f5;color:#7b1fa2;margin:0.1rem;">' + esc(c) + '</span>';
      });
      if (cats.length > 8) html += '<span style="font-size:0.72rem;color:#999;"> +' + (cats.length - 8) + ' more</span>';
      html += '</div>';
    }

    
    if (_fmVersion === 2) {
      var domains = f.domains || [];
      html += '<div class="feed-domains" data-feed-id="' + f.id + '">';
      html += '<strong style="font-size:0.78rem; color:#666;">Domain Tags:</strong> ';
      if (domains.length > 0) {
        domains.forEach(function (d) {
          html += '<span class="domain-tag">' + esc(d) + '</span>';
        });
      } else {
        html += '<span style="font-size:0.78rem; color:#999; font-style:italic;">none</span>';
      }
      html += ' <a href="#" class="edit-domains-link" data-feed-id="' + f.id + '" data-domains="' + esc(domains.join(', ')) + '" style="font-size:0.72rem;color:#0073b1;">edit tags</a>';
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  

  var _fmVersion = 1; 

  function loadFeeds(topicFilter) {
    var url = API + '/api/feeds';
    if (topicFilter) url += '?topic=' + encodeURIComponent(topicFilter);

    fetch(url, { credentials: 'include' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        _fmVersion = parseInt(data.feedsManagerVersion, 10) || 1;
        var titleEl = document.getElementById('page-title');
        if (titleEl) titleEl.innerHTML = 'Feeds Manager <span class="version-badge">(v' + _fmVersion + ')</span><p class="subtitle">RSS feeds for research material</p>';
        var feeds = data.feeds || [];
        var catchall = feeds.filter(function (f) { return f.is_catchall; });
        var topicSpecific = feeds.filter(function (f) { return !f.is_catchall; });

        
        $('catchall-count').textContent = catchall.length;
        if (catchall.length === 0) {
          $('catchall-feeds').innerHTML = '<span class="empty">No catchall feeds configured</span>';
        } else {
          var html = '';
          catchall.forEach(function (f) { html += renderFeedCard(f); });
          $('catchall-feeds').innerHTML = html;
        }

        
        $('topic-feed-count').textContent = topicSpecific.length;
        if (topicSpecific.length === 0) {
          $('topic-feeds').innerHTML = '<span class="empty">No topic-specific feeds' +
            (topicFilter ? ' for this topic' : '') + '</span>';
        } else {
          var html2 = '';
          topicSpecific.forEach(function (f) { html2 += renderFeedCard(f); });
          $('topic-feeds').innerHTML = html2;
        }
      })
      .catch(function () {
        $('catchall-feeds').innerHTML = '<span class="msg msg-error">Failed to load feeds</span>';
        $('topic-feeds').innerHTML = '';
      });
  }

  // ── Load topic selector ────────────────────────────────────

  function loadTopicSelector() {
    fetch(API + '/api/feeds/summary', { credentials: 'include' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var select = $('topic-selector');
        select.innerHTML = '<option value="">All topics</option>';
        (data.topics || []).forEach(function (t) {
          var opt = document.createElement('option');
          opt.value = t.slug;
          opt.textContent = t.name + ' (' + t.feedCount + ' topic feeds)';
          select.appendChild(opt);
        });

        
        var params = new URLSearchParams(window.location.search);
        var topicParam = params.get('topic');
        if (topicParam) {
          select.value = topicParam;
          loadFeeds(topicParam);
        } else {
          loadFeeds(null);
        }
      })
      .catch(function () { loadFeeds(null); });
  }

  

  checkAccess().then(function (allowed) {
    $('loading').style.display = 'none';
    if (!allowed) {
      $('denied').style.display = 'block';
      setTimeout(function () { window.location.href = '/app'; }, 3000);
      return;
    }
    $('feeds-app').style.display = 'block';
    loadTopicSelector();

    $('topic-selector').addEventListener('change', function () {
      var slug = this.value;
      
      var url = slug ? '?topic=' + encodeURIComponent(slug) : window.location.pathname;
      window.history.replaceState(null, '', url);
      loadFeeds(slug || null);
    });

    // ── Domain tag editing (delegated, v2 only) ──────────────────
    document.addEventListener('click', function (e) {
      var link = e.target.closest('.edit-domains-link');
      if (!link) return;
      e.preventDefault();

      
      if (_fmVersion !== 2) return;
      var feedId = link.dataset.feedId;
      var currentDomains = link.dataset.domains || '';
      var input = prompt('Domain tags (comma-separated):', currentDomains);
      if (input === null) return;

      var domains = input.split(',').map(function (d) { return d.trim().toLowerCase(); }).filter(Boolean);

      fetch(API + '/api/feeds/' + feedId + '/domains', {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains: domains })
      })
        .then(function (res) {
          if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed'); });
          loadFeeds();
        })
        .catch(function (err) {
          alert('Failed to update domains: ' + err.message);
        });
    });
  });
})();
