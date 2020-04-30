/* vim: set ts=2 sts=2 sw=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

(function() {
"use strict";

var MAXIMUM_HIGHLIGHT_COUNT = 30000;
var SCROLL_OFFSET_Y = 60;
var SCROLL_DURATION = 400;

var HIGHLIGHT_CLASS_NAME = "viki-searchresult";
var HIGHLIGHT_CLASS_NAME_ACTIVE = "viki-searchresult--active";

var lastEscapedQuery = "";
var lastFindOperation = null;
var lastReplacements = null;
var lastHighlights = null;
var activeHighlightIndex = -1;

var highlightSpan = document.createElement("span");
highlightSpan.className = HIGHLIGHT_CLASS_NAME;

var styleElement = document.createElement("style");

function find(query) {
  var trimmedQuery = query.trim();

  // If the trimmed query is empty, use it instead of the escaped
  // query to prevent searching for nothing but whitepsace.
  var escapedQuery = !trimmedQuery ? trimmedQuery : query.replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1");
  if (escapedQuery === lastEscapedQuery) {
    webkit.messageHandlers.findInPageHandler.postMessage({ currentResult: 0, totalResults: 0 });
    return;
  }

  if (lastFindOperation) {
    lastFindOperation.cancel();
  }

  clear();

  lastEscapedQuery = escapedQuery;

  if (!escapedQuery) {
    webkit.messageHandlers.findInPageHandler.postMessage({ currentResult: 0, totalResults: 0 });
    return;
  }

  var queryRegExp = new RegExp("(" + escapedQuery + ")", "gi");

  lastFindOperation = getMatchingNodeReplacements(queryRegExp, function(replacements, highlights) {
    var replacement;
    for (var i = 0, length = replacements.length; i < length; i++) {
      replacement = replacements[i];

      replacement.originalNode.replaceWith(replacement.replacementFragment);
    }

    lastFindOperation = null;
    lastReplacements = replacements;
    lastHighlights = highlights;
    activeHighlightIndex = -1;

    var totalResults = highlights.length;
    webkit.messageHandlers.findInPageHandler.postMessage({ totalResults: totalResults });

    findNext();
  });
}

function findNext() {
  if (lastHighlights) {
    activeHighlightIndex = (activeHighlightIndex + lastHighlights.length + 1) % lastHighlights.length;
    updateActiveHighlight();
  }
}

function findPrevious() {
  if (lastHighlights) {
    activeHighlightIndex = (activeHighlightIndex + lastHighlights.length - 1) % lastHighlights.length;
    updateActiveHighlight();
  }
}

function findDone() {
  styleElement.remove();
  clear();

  lastEscapedQuery = "";
}

function clear() {
  if (!lastHighlights) {
    return;
  }

  var replacements = lastReplacements;
  var highlights = lastHighlights;

  var highlight;
  for (var i = 0, length = highlights.length; i < length; i++) {
    highlight = highlights[i];

    removeHighlight(highlight);
  }

  lastReplacements = null;
  lastHighlights = null;
  activeHighlightIndex = -1;
}

function updateActiveHighlight() {
  if (!styleElement.parentNode) {
    document.body.appendChild(styleElement);
  }

  var lastActiveHighlight = document.querySelector("." + HIGHLIGHT_CLASS_NAME_ACTIVE);
  if (lastActiveHighlight) {
    lastActiveHighlight.className = HIGHLIGHT_CLASS_NAME;
  }

  if (!lastHighlights) {
    return;
  }

  var activeHighlight = lastHighlights[activeHighlightIndex];
  if (activeHighlight) {
    activeHighlight.className = HIGHLIGHT_CLASS_NAME + " " + HIGHLIGHT_CLASS_NAME_ACTIVE;
    scrollToElement(activeHighlight, SCROLL_DURATION);

    webkit.messageHandlers.findInPageHandler.postMessage({ currentResult: activeHighlightIndex + 1 });
  } else {
    webkit.messageHandlers.findInPageHandler.postMessage({ currentResult: 0 });
  }
}

function removeHighlight(highlight) {
  var parent = highlight.parentNode;
  if (parent) {
    while (highlight.firstChild) {
      parent.insertBefore(highlight.firstChild, highlight);
    }

    highlight.remove();
    parent.normalize();
  }
}

function asyncTextNodeWalker(iterator) {
  var operation = new Operation();
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);

  var timeout = setTimeout(function() {
    chunkedLoop(function() { return walker.nextNode(); }, function(node) {
      if (operation.cancelled) {
        return false;
      }

      iterator(node);
      return true;
    }, 100).then(function() {
      operation.complete();
    });
  }, 50);

  operation.oncancelled = function() {
    clearTimeout(timeout);
  };

  return operation;
}

function getMatchingNodeReplacements(regExp, callback) {
  var replacements = [];
  var highlights = [];
  var isMaximumHighlightCount = false;

  var operation = asyncTextNodeWalker(function(originalNode) {
    if (!isTextNodeVisible(originalNode) || originalNode.parentElement.nodeName === "IFRAME") {
      return;
    }

    var originalTextContent = originalNode.textContent;
    var lastIndex = 0;
    var replacementFragment = document.createDocumentFragment();
    var hasReplacement = false;
    var match;

    while ((match = regExp.exec(originalTextContent))) {
      var matchTextContent = match[0];

      // Add any text before this match.
      if (match.index > 0) {
        var leadingSubstring = originalTextContent.substring(lastIndex, match.index);
        replacementFragment.appendChild(document.createTextNode(leadingSubstring));
      }

      // Add element for this match.
      var element = highlightSpan.cloneNode(false);
      element.textContent = matchTextContent;
      replacementFragment.appendChild(element);
      highlights.push(element);

      lastIndex = regExp.lastIndex;
      hasReplacement = true;

      if (highlights.length > MAXIMUM_HIGHLIGHT_COUNT) {
        isMaximumHighlightCount = true;
        break;
      }
    }

    if (hasReplacement) {
      // Add any text after the matches.
      if (lastIndex < originalTextContent.length) {
        var trailingSubstring = originalTextContent.substring(lastIndex, originalTextContent.length);
        replacementFragment.appendChild(document.createTextNode(trailingSubstring));
      }

      replacements.push({
        originalNode: originalNode,
        replacementFragment: replacementFragment
      });
    }

    if (isMaximumHighlightCount) {
      operation.cancel();
      callback(replacements, highlights);
    }
  });

  // Callback for if/when the text node loop completes (should
  // happen unless the maximum highlight count is reached).
  operation.oncompleted = function() {
    callback(replacements, highlights);
  };

  return operation;
}

function chunkedLoop(condition, iterator, chunkSize) {
  return new Promise(function(resolve, reject) {
    setTimeout(doChunk, 0);

    function doChunk() {
      var argument;
      for (var i = 0; i < chunkSize; i++) {
        argument = condition();
        if (!argument || iterator(argument) === false) {
          resolve();
          return;
        }
      }

      setTimeout(doChunk, 0);
    }
  });
}

function scrollToElement(element, duration) {
  var rect = element.getBoundingClientRect();

  var targetX = clamp(rect.left + window.scrollX - window.innerWidth / 2, 0, document.body.scrollWidth);
  var targetY = clamp(SCROLL_OFFSET_Y + rect.top + window.scrollY - window.innerHeight / 2, 0, document.body.scrollHeight);

  var startX = window.scrollX;
  var startY = window.scrollY;

  var deltaX = targetX - startX;
  var deltaY = targetY - startY;

  var startTimestamp;

  function step(timestamp) {
    if (!startTimestamp) {
      startTimestamp = timestamp;
    }

    var time = timestamp - startTimestamp;
    var percent = Math.min(time / duration, 1);

    // var x = startX + deltaX * percent;
    // var y = startY + deltaY * percent;

    var x = easeOutCubic(time, startX, deltaX, duration);
    var y = easeOutCubic(time, startY, deltaY, duration);

    window.scrollTo(x, y);

    if (time < duration) {
      requestAnimationFrame(step);
    }
  }

  requestAnimationFrame(step);
}

function easeOutCubic(currentTime, startValue, changeInValue, duration) {
  return changeInValue * (Math.pow(currentTime / duration - 1, 3) + 1) + startValue;
}

function isTextNodeVisible(textNode) {
  var element = textNode.parentElement;
  if (!element) {
    return false;
  }
  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function Operation() {
  this.cancelled = false;
  this.completed = false;
}

Operation.prototype.constructor = Operation;

Operation.prototype.cancel = function() {
  this.cancelled = true;

  if (typeof this.oncancelled === "function") {
    this.oncancelled();
  }
};

Operation.prototype.complete = function() {
  this.completed = true;

  if (typeof this.oncompleted === "function") {
    if (!this.cancelled) {
      this.oncompleted();
    }
  }
};

Object.defineProperty(window.Viki, "find", {
  enumerable: false,
  configurable: false,
  writable: false,
  value: find
});

Object.defineProperty(window.Viki, "findNext", {
  enumerable: false,
  configurable: false,
  writable: false,
  value: findNext
});

Object.defineProperty(window.Viki, "findPrevious", {
  enumerable: false,
  configurable: false,
  writable: false,
  value: findPrevious
});

Object.defineProperty(window.Viki, "findDone", {
  enumerable: false,
  configurable: false,
  writable: false,
  value: findDone
});
}) ();

