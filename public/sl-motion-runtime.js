/*
 * StyleLift — the page's motion, replayed (generated with this export; no dependencies).
 *  • Entrances that wait until they are scrolled into view ([data-sl-in-on="enter"], Studio "Scroll into view")
 *    are held at their first frame and played as they come in; word-by-word texts are split into words. In a
 *    pinned section (on screen all along) they play once the page has scrolled to where they did ([data-sl-in-at]).
 *  • The site's own one-shot CSS animations further down ([data-sl-hold]) wait the same way.
 *  • Widgets the site's scripts ran: tabs ([data-sl-tabs]), gallery arrows ([data-sl-paddle] + [data-sl-scroller]),
 *    video buttons ([data-sl-media]) and the playing / paused / ended classes the site's CSS reads.
 *  • Classes the page put on itself past a scroll position ([data-sl-scroll-classes]).
 *  • Pointer effects (magnetic, 3D tilt, cursor followers) and videos played once as they come into view.
 * Remove this script and everything simply shows in its final state.
 */
(function motionRuntime(doc, win, split) {
  var cs = function(el2, p) {
    return win.getComputedStyle(el2).getPropertyValue(p).trim();
  };
  var targets = function(el2) {
    var list2 = [el2];
    if (el2.hasAttribute("data-slm-split")) list2 = list2.concat([].slice.call(el2.querySelectorAll(".slm-w")));
    else if (parseFloat(cs(el2, "--slm-stagger")) > 0) list2 = list2.concat([].slice.call(el2.children));
    return list2;
  };
  var anims = function(el2) {
    var out = [];
    var own = el2.hasAttribute("data-sl-hold");
    var t = targets(el2);
    for (var i2 = 0; i2 < t.length; i2++) {
      var a = typeof t[i2].getAnimations === "function" ? t[i2].getAnimations() : [];
      for (var j = 0; j < a.length; j++) if (/^(slm-|sl-in-)/.test(a[j].animationName || "") || own && a[j].timeline === doc.timeline && !!a[j].animationName) out.push(a[j]);
    }
    return out;
  };
  var hold = function(el2) {
    var a = anims(el2);
    for (var i2 = 0; i2 < a.length; i2++) {
      a[i2].pause();
      a[i2].currentTime = 0;
    }
  };
  var play = function(el2) {
    var a = anims(el2);
    for (var i2 = 0; i2 < a.length; i2++) a[i2].play();
  };
  var mm = function(q) {
    return !!win.matchMedia && win.matchMedia(q).matches;
  };
  var pointer = mm("(hover: hover) and (pointer: fine)") && !mm("(prefers-reduced-motion: reduce)");
  var follow = function(host, magnet, tilt) {
    var pull = host.hasAttribute("data-sl-pull") ? host : host.querySelector("[data-sl-pull]") || host;
    var tiltEl = host.hasAttribute("data-sl-tilting") ? host : host.querySelector("[data-sl-tilting]") || host;
    host.addEventListener("pointermove", function(ev) {
      var e = ev;
      var r = host.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      if (magnet) {
        pull.style.setProperty("--slm-mx", (dx * magnet).toFixed(1) + "px");
        pull.style.setProperty("--slm-my", (dy * magnet).toFixed(1) + "px");
      }
      if (tilt) {
        tiltEl.style.setProperty("--slm-rx", (-dy / Math.max(1, r.height / 2) * tilt).toFixed(2) + "deg");
        tiltEl.style.setProperty("--slm-ry", (dx / Math.max(1, r.width / 2) * tilt).toFixed(2) + "deg");
      }
    });
    host.addEventListener("pointerleave", function() {
      var ps = ["--slm-mx", "--slm-my", "--slm-rx", "--slm-ry"];
      for (var i2 = 0; i2 < ps.length; i2++) {
        pull.style.removeProperty(ps[i2]);
        tiltEl.style.removeProperty(ps[i2]);
      }
    });
  };
  if (pointer) {
    var site = [].slice.call(doc.querySelectorAll("[data-sl-magnet], [data-sl-tilt]"));
    for (var si = 0; si < site.length; si++) follow(site[si], parseFloat(site[si].getAttribute("data-sl-magnet") || "") || 0, parseFloat(site[si].getAttribute("data-sl-tilt") || "") || 0);
    var cur = [].slice.call(doc.querySelectorAll("[data-sl-cursor]"));
    if (cur.length) {
      var px = -1, py = -1;
      var st = cur.map(function(el2) {
        var o = {};
        try {
          o = JSON.parse(el2.getAttribute("data-sl-cursor") || "{}");
        } catch (e) {
          o = {};
        }
        return { el: el2, k: Math.max(0.02, Math.min(1, o.k || 0.2)), ox: o.ox || 0, oy: o.oy || 0, x: 0, y: 0, c: null };
      });
      var tick = function() {
        for (var i2 = 0; i2 < st.length; i2++) {
          var f = st[i2];
          if (!f.c) {
            var r = f.el.getBoundingClientRect();
            f.c = { x: r.left + r.width / 2 - f.x, y: r.top + r.height / 2 - f.y };
          }
          var tx = px + f.ox - f.c.x, ty = py + f.oy - f.c.y;
          f.x += (tx - f.x) * f.k;
          f.y += (ty - f.y) * f.k;
          f.el.style.setProperty("--slm-cx", f.x.toFixed(1) + "px");
          f.el.style.setProperty("--slm-cy", f.y.toFixed(1) + "px");
        }
        win.requestAnimationFrame(tick);
      };
      var started = false;
      win.addEventListener("pointermove", function(ev) {
        px = ev.clientX;
        py = ev.clientY;
        if (!started) {
          started = true;
          win.requestAnimationFrame(tick);
        }
      }, { passive: true });
    }
  }
  var vids = mm("(prefers-reduced-motion: reduce)") ? [] : [].slice.call(doc.querySelectorAll('video[data-sl-play="enter"]'));
  if (vids.length) {
    var vTop = function(el2) {
      var y = 0;
      for (var m = el2; m; m = m.offsetParent) y += m.offsetTop || 0;
      return y;
    };
    var played = [];
    var vCheck = function() {
      var line = (win.scrollY || 0) + win.innerHeight * 0.88, left = 0;
      for (var i2 = 0; i2 < vids.length; i2++) {
        if (played[i2]) continue;
        if (vTop(vids[i2]) < line) {
          played[i2] = true;
          vids[i2].muted = true;
          try {
            var pr = vids[i2].play();
            if (pr && pr.catch) pr.catch(function() {
            });
          } catch (e) {
          }
        } else left++;
      }
      if (!left) win.removeEventListener("scroll", vScroll);
    };
    var vQueued = false;
    var vScroll = function() {
      if (vQueued) return;
      vQueued = true;
      win.requestAnimationFrame(function() {
        vQueued = false;
        vCheck();
      });
    };
    win.addEventListener("scroll", vScroll, { passive: true });
    win.addEventListener("load", vCheck);
    vCheck();
  }
  var list = function(sel, root) {
    return [].slice.call((root || doc).querySelectorAll(sel));
  };
  var still = mm("(prefers-reduced-motion: reduce)");
  var learn = function(on2, offs) {
    var ATTRS = ["aria-selected", "aria-hidden", "aria-expanded", "aria-current", "hidden", "tabindex", "inert", "data-state", "data-active"];
    var cl = function(e) {
      return [].slice.call(e.classList);
    };
    var onCls = cl(on2).filter(function(c) {
      return offs.every(function(o) {
        return !o.classList.contains(c);
      });
    });
    var offCls = cl(offs[0]).filter(function(c) {
      return !on2.classList.contains(c) && offs.every(function(o) {
        return o.classList.contains(c);
      });
    });
    var attrs = [];
    for (var i2 = 0; i2 < ATTRS.length; i2++) {
      var a = ATTRS[i2], vOn = on2.getAttribute(a), vOff = offs[0].getAttribute(a);
      if (vOn !== vOff && offs.every(function(o) {
        return o.getAttribute(a) === vOff;
      })) attrs.push([a, vOn, vOff]);
    }
    var css = [];
    var props = [];
    var st2 = function(e) {
      return e.style || null;
    };
    var add = function(e) {
      var s0 = st2(e);
      for (var k5 = 0; s0 && k5 < s0.length; k5++) if (props.indexOf(s0.item(k5)) < 0) props.push(s0.item(k5));
    };
    add(on2);
    add(offs[0]);
    for (var j = 0; j < props.length; j++) {
      var p = props[j], sOn = st2(on2) ? st2(on2).getPropertyValue(p) : "", sOff = st2(offs[0]) ? st2(offs[0]).getPropertyValue(p) : "";
      if (sOn !== sOff && offs.every(function(o) {
        return (st2(o) ? st2(o).getPropertyValue(p) : "") === sOff;
      })) css.push([p, sOn, sOff]);
    }
    return function(e, yes) {
      for (var a1 = 0; a1 < onCls.length; a1++) e.classList.toggle(onCls[a1], yes);
      for (var a2 = 0; a2 < offCls.length; a2++) e.classList.toggle(offCls[a2], !yes);
      for (var a3 = 0; a3 < attrs.length; a3++) {
        var v = yes ? attrs[a3][1] : attrs[a3][2];
        if (v === null) e.removeAttribute(attrs[a3][0]);
        else e.setAttribute(attrs[a3][0], v);
      }
      for (var a4 = 0; a4 < css.length; a4++) {
        var cv = yes ? css[a4][1] : css[a4][2];
        if (cv) e.style.setProperty(css[a4][0], cv);
        else e.style.removeProperty(css[a4][0]);
      }
    };
  };
  var sideScroller = function(el2) {
    for (var a = el2.parentElement; a && a !== doc.body; a = a.parentElement) if (/auto|scroll/.test(cs(a, "overflow-x")) && a.scrollWidth > a.clientWidth + 4) return a;
    return null;
  };
  var tabLists = list("[data-sl-tabs]");
  for (var ti = 0; ti < tabLists.length; ti++)
    (function(tl) {
      var tabs = list('[role="tab"]', tl).filter(function(t) {
        return t.closest('[role="tablist"]') === tl;
      });
      var panelOf = function(t) {
        var id = (t.getAttribute("aria-controls") || "").split(" ")[0];
        var pn = id ? doc.getElementById(id) : null;
        if (!pn && t.id) pn = list('[role="tabpanel"][aria-labelledby]').filter(function(x) {
          return (" " + x.getAttribute("aria-labelledby") + " ").indexOf(" " + t.id + " ") >= 0;
        })[0] || null;
        return pn;
      };
      var panels = tabs.map(panelOf);
      if (tabs.length < 2 || panels.some(function(pn, k6) {
        return !pn || panels.indexOf(pn) !== k6;
      })) return;
      var cur2 = 0;
      for (var k5 = 0; k5 < tabs.length; k5++) if (tabs[k5].getAttribute("aria-selected") === "true" || tabs[k5].checked) {
        cur2 = k5;
        break;
      }
      var others = function(arr) {
        return arr.filter(function(_, k22) {
          return k22 !== cur2;
        });
      };
      var tabLook = learn(tabs[cur2], others(tabs));
      var wraps = tabs.map(function(t) {
        return t.parentElement;
      });
      var wrapLook = wraps.every(function(w, k32) {
        return w && w !== tl && wraps.indexOf(w) === k32;
      }) ? learn(wraps[cur2], others(wraps)) : null;
      var sc = sideScroller(panels[0]);
      var slide = !!sc && sc.contains(panels[1]) && Math.abs(panels[0].getBoundingClientRect().left - panels[1].getBoundingClientRect().left) > 20;
      var panLook = slide ? null : learn(panels[cur2], others(panels));
      var show = function(i2, move) {
        for (var m = 0; m < tabs.length; m++) {
          tabLook(tabs[m], m === i2);
          if (wrapLook) wrapLook(wraps[m], m === i2);
          if (panLook) panLook(panels[m], m === i2);
        }
        if (tabs[i2] instanceof HTMLInputElement) tabs[i2].checked = true;
        if (slide && move && sc) sc.scrollTo({ left: sc.scrollLeft + panels[i2].getBoundingClientRect().left - sc.getBoundingClientRect().left, behavior: still ? "auto" : "smooth" });
        else if (!slide && i2 !== cur2 && !still && typeof panels[i2].animate === "function") panels[i2].animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: "ease" });
        cur2 = i2;
      };
      tabs.forEach(function(t, i2) {
        t.addEventListener("click", function(e) {
          if (!(t instanceof HTMLInputElement)) e.preventDefault();
          if (i2 !== cur2) show(i2, true);
        });
      });
      tl.addEventListener("keydown", function(e) {
        var key = e.key, d = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = (cur2 + d + tabs.length) % tabs.length;
        show(n, true);
        tabs[n].focus();
      });
      if (slide && sc) {
        var q = false;
        sc.addEventListener("scroll", function() {
          if (q) return;
          q = true;
          win.requestAnimationFrame(function() {
            q = false;
            var left = sc.getBoundingClientRect().left, best = cur2, bd = 1e9;
            for (var m = 0; m < panels.length; m++) {
              var dd = Math.abs(panels[m].getBoundingClientRect().left - left);
              if (dd < bd) {
                bd = dd;
                best = m;
              }
            }
            if (best !== cur2) show(best, false);
          });
        }, { passive: true });
      }
    })(tabLists[ti]);
  var strips = {};
  var sEls = list("[data-sl-scroller]");
  for (var sj = 0; sj < sEls.length; sj++) {
    var sv = (sEls[sj].getAttribute("data-sl-scroller") || "").split(":");
    strips[sv[1]] = { el: sEls[sj], kind: sv[0], btns: [] };
  }
  var pads = list("[data-sl-paddle]");
  for (var pj = 0; pj < pads.length; pj++) {
    var pv = (pads[pj].getAttribute("data-sl-paddle") || "").split(":");
    if (strips[pv[1]]) strips[pv[1]].btns.push([pads[pj], parseFloat(pv[0]) < 0 ? -1 : 1]);
  }
  for (var sid in strips)
    (function(g) {
      if (!g.btns.length) return;
      var track = g.el;
      if (g.kind === "track") track = g.el.children[0];
      else while (track.children.length === 1) track = track.children[0];
      var items = function() {
        return [].slice.call(track.children).filter(function(it) {
          return it.offsetWidth > 0;
        });
      };
      var x = 0;
      if (g.kind === "track") {
        var mt = /matrix(3d)?\(([^)]+)\)/.exec(cs(track, "transform"));
        if (mt) {
          var nums = mt[2].split(",");
          x = parseFloat(nums[mt[1] ? 12 : 4]) || 0;
        }
      }
      var ends = function() {
        var its = items();
        if (!its.length) return;
        var r = g.el.getBoundingClientRect();
        var atStart = g.kind === "track" ? its[0].getBoundingClientRect().left >= r.left - 2 : g.el.scrollLeft <= 1;
        var atEnd = g.kind === "track" ? its[its.length - 1].getBoundingClientRect().right <= r.right + 2 : g.el.scrollLeft >= g.el.scrollWidth - g.el.clientWidth - 1;
        for (var b2 = 0; b2 < g.btns.length; b2++) {
          var off = g.btns[b2][1] < 0 ? atStart : atEnd, bt = g.btns[b2][0];
          if (bt instanceof HTMLButtonElement) bt.disabled = off;
          bt.setAttribute("aria-disabled", off ? "true" : "false");
        }
      };
      var aim = null, aimT = 0;
      var go = function(dir) {
        var its = items();
        if (!its.length) return;
        var r = g.el.getBoundingClientRect();
        var pad = g.kind === "track" ? 0 : parseFloat(cs(g.el, "scroll-padding-left")) || parseFloat(cs(g.el, "padding-left")) || 0;
        var base = g.kind !== "track" && aim !== null ? aim : g.el.scrollLeft;
        var lefts = its.map(function(it) {
          return it.getBoundingClientRect().left - r.left - pad - (base - g.el.scrollLeft);
        });
        var to = -1;
        if (dir > 0) {
          for (var i2 = 0; i2 < lefts.length; i2++) if (lefts[i2] > 2) {
            to = i2;
            break;
          }
        } else for (var i22 = lefts.length - 1; i22 >= 0; i22--) if (lefts[i22] < -2) {
          to = i22;
          break;
        }
        var d = to >= 0 ? lefts[to] : dir * g.el.clientWidth * 0.8;
        if (g.kind === "track") {
          var lastR = its[its.length - 1].getBoundingClientRect().right - r.right, firstL = its[0].getBoundingClientRect().left - r.left;
          d = dir > 0 ? Math.min(d, Math.max(0, lastR)) : Math.max(d, Math.min(0, firstL));
          x -= d;
          track.style.transition = still ? "none" : "transform .6s cubic-bezier(.25,.8,.25,1)";
          track.style.transform = "translate3d(" + x.toFixed(1) + "px, 0px, 0px)";
          win.setTimeout(ends, still ? 0 : 650);
        } else {
          var to2 = Math.max(0, Math.min(g.el.scrollWidth - g.el.clientWidth, base + d));
          aim = to2;
          var t0 = ++aimT;
          win.setTimeout(function() {
            if (t0 === aimT) aim = null;
          }, 900);
          g.el.scrollTo({ left: to2, behavior: still ? "auto" : "smooth" });
        }
      };
      for (var b = 0; b < g.btns.length; b++)
        (function(bt, dir) {
          bt.addEventListener("click", function(e) {
            e.preventDefault();
            go(dir);
          });
        })(g.btns[b][0], g.btns[b][1]);
      if (g.kind !== "track") g.el.addEventListener("scroll", function() {
        win.requestAnimationFrame(ends);
      }, { passive: true });
      ends();
      win.addEventListener("load", ends);
    })(strips[sid]);
  var mvs = list("video[data-sl-media-v]");
  for (var mj = 0; mj < mvs.length; mj++)
    (function(v) {
      var id = v.getAttribute("data-sl-media-v");
      var uis = list('[data-sl-media-ui="' + id + '"]');
      var state = function(s1) {
        for (var u = 0; u < uis.length; u++) {
          uis[u].classList.remove("playing", "paused", "ended");
          uis[u].classList.add(s1);
        }
      };
      v.addEventListener("play", function() {
        state("playing");
      });
      v.addEventListener("pause", function() {
        if (!v.ended) state("paused");
      });
      v.addEventListener("ended", function() {
        state("ended");
      });
      var btns = list('[data-sl-media="' + id + '"]');
      for (var bj = 0; bj < btns.length; bj++)
        btns[bj].addEventListener("click", function(e) {
          e.preventDefault();
          if (v.paused || v.ended) {
            if (v.ended) v.currentTime = 0;
            v.muted = true;
            var pr = v.play();
            if (pr && pr.catch) pr.catch(function() {
            });
          } else v.pause();
        });
    })(mvs[mj]);
  var sClsEls = list("[data-sl-scroll-classes]");
  if (sClsEls.length) {
    var sRules = sClsEls.map(function(el2) {
      var r = [];
      try {
        r = JSON.parse(el2.getAttribute("data-sl-scroll-classes") || "[]");
      } catch (e) {
        r = [];
      }
      return { el: el2, r };
    });
    var sApply = function() {
      var y = win.scrollY || 0;
      for (var i2 = 0; i2 < sRules.length; i2++)
        for (var j = 0; j < sRules[i2].r.length; j++) {
          var ru = sRules[i2].r[j];
          sRules[i2].el.classList.toggle(ru.t, y >= ru.a && (ru.b === null || y < ru.b));
        }
    };
    var sQ = false;
    win.addEventListener("scroll", function() {
      if (sQ) return;
      sQ = true;
      win.requestAnimationFrame(function() {
        sQ = false;
        sApply();
      });
    }, { passive: true });
    sApply();
  }
  var all = [].slice.call(doc.querySelectorAll("[data-sl-id], [data-sl-in-on], [data-sl-hold]"));
  var enter = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.hasAttribute("data-sl-hold")) {
      enter.push(el);
      continue;
    }
    var on = cs(el, "--slm-on");
    if (on === "hover" && pointer) {
      var hf = cs(el, "--slm-fx");
      if (hf === "magnet") follow(el, (parseFloat(cs(el, "--slm-dist")) || 14) / Math.max(20, el.getBoundingClientRect().width / 2), 0);
      if (hf === "tilt3d") follow(el, 0, parseFloat(cs(el, "--slm-dist")) || 10);
      continue;
    }
    if (on !== "enter" && on !== "load") continue;
    if (cs(el, "--slm-fx") === "words") split(doc, el);
    if (on === "enter") enter.push(el);
  }
  if (!enter.length || typeof doc.documentElement.getAnimations !== "function") return;
  var topOf = function(el2) {
    var n = el2;
    while (n && typeof n.offsetTop !== "number") n = n.parentElement;
    var y = 0;
    for (var m = n; m; m = m.offsetParent) y += m.offsetTop || 0;
    return y;
  };
  var tops = [];
  var ats = [];
  for (var ia = 0; ia < enter.length; ia++) ats[ia] = parseFloat(enter[ia].getAttribute("data-sl-in-at") || "");
  var measure = function() {
    for (var i2 = 0; i2 < enter.length; i2++) tops[i2] = topOf(enter[i2]);
  };
  var done = [];
  var check = function() {
    var y = win.scrollY || (doc.documentElement ? doc.documentElement.scrollTop : 0) || 0;
    var line = y + win.innerHeight * 0.88;
    var left = 0;
    for (var i2 = 0; i2 < enter.length; i2++) {
      var el2 = enter[i2];
      var again = cs(el2, "--slm-replay") === "1";
      if (!done[i2] && (ats[i2] >= 0 ? y >= ats[i2] - 2 : tops[i2] < line)) {
        play(el2);
        done[i2] = true;
      } else if (done[i2] && again && tops[i2] > y + win.innerHeight) {
        hold(el2);
        done[i2] = false;
      }
      if (!done[i2] || again) left++;
    }
    if (!left) {
      win.removeEventListener("scroll", onScroll);
      win.removeEventListener("resize", onResize);
    }
  };
  var queued = false;
  var onScroll = function() {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(function() {
      queued = false;
      check();
    });
  };
  var onResize = function() {
    measure();
    onScroll();
  };
  var tg = [];
  for (var k = 0; k < enter.length; k++) tg = tg.concat(targets(enter[k]));
  for (var k1 = 0; k1 < tg.length; k1++) tg[k1].style.setProperty("animation-name", "none", "important");
  void (doc.body && doc.body.offsetWidth);
  for (var k2 = 0; k2 < tg.length; k2++) tg[k2].style.removeProperty("animation-name");
  var docAnims = typeof doc.getAnimations === "function" ? doc.getAnimations() : null;
  if (docAnims) {
    var held = new Set(tg);
    for (var k3 = 0; k3 < docAnims.length; k3++) {
      var an = docAnims[k3];
      var tgt = an.effect && an.effect.target;
      if (tgt && held.has(tgt) && (/^(slm-|sl-in-)/.test(an.animationName || "") || tgt.hasAttribute("data-sl-hold") && an.timeline === doc.timeline && !!an.animationName)) {
        an.pause();
        an.currentTime = 0;
      }
    }
  } else for (var k4 = 0; k4 < enter.length; k4++) hold(enter[k4]);
  measure();
  check();
  win.addEventListener("scroll", onScroll, { passive: true });
  win.addEventListener("resize", onResize);
  win.addEventListener("load", onResize);
})(document, window, function splitWords(doc, el) {
  if (el.hasAttribute("data-slm-split")) return;
  var i = 0;
  var walk = function(n) {
    var kids = [].slice.call(n.childNodes);
    for (var k = 0; k < kids.length; k++) {
      var c = kids[k];
      if (c.nodeType === 3) {
        var text = c.nodeValue || "";
        if (!text.trim()) continue;
        var frag = doc.createDocumentFragment();
        var parts = text.split(/(\s+)/);
        for (var j = 0; j < parts.length; j++) {
          var p = parts[j];
          if (!p) continue;
          if (/^\s+$/.test(p)) frag.appendChild(doc.createTextNode(p));
          else {
            var s = doc.createElement("span");
            s.className = "slm-w";
            s.style.setProperty("--slm-i", String(i++));
            s.textContent = p;
            frag.appendChild(s);
          }
        }
        n.replaceChild(frag, c);
      } else if (c.nodeType === 1 && !/^(script|style|svg|img|br|video|canvas|iframe)$/i.test(c.localName)) walk(c);
    }
  };
  walk(el);
  el.setAttribute("data-slm-split", "");
});
