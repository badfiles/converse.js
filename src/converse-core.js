// Converse.js (A browser based XMPP chat client)
// http://conversejs.org
//
// Copyright (c) 2012-2016, Jan-Carel Brand <jc@opkode.com>
// Licensed under the Mozilla Public License (MPLv2)
//
/*global Backbone, define, window, document, locales */

(function (root, factory) {
    // Two modules are loaded as dependencies.
    //
    // * **converse-dependencies**: A list of dependencies converse.js depends on.
    //   The path to this module is in main.js and the module itself can be overridden.
    // * **converse-templates**: The HTML templates used by converse.js.
    //
    // The dependencies are then split up and passed into the factory function,
    // which contains and instantiates converse.js.
    define("converse-core", [
        "jquery",
        "underscore",
        "polyfill",
        "utils",
        "moment_with_locales",
        "strophe",
        "converse-templates",
        "strophe.disco",
        "strophe.rsm",
        "strophe.vcard",
        "backbone.browserStorage",
        "backbone.overview",
        "typeahead",
    ], factory);
}(this, function ($, _, dummy, utils, moment, Strophe, templates) {
    /* 
     * Cannot use this due to Safari bug.
     * See https://github.com/jcbrand/converse.js/issues/196
     */
    // "use strict";

    // Strophe globals
    var $build = Strophe.$build;
    var $iq = Strophe.$iq;
    var $msg = Strophe.$msg;
    var $pres = Strophe.$pres;
    var b64_sha1 = Strophe.SHA1.b64_sha1;
    Strophe = Strophe.Strophe;

    // Use Mustache style syntax for variable interpolation
    /* Configuration of underscore templates (this config is distinct to the
     * config of requirejs-tpl in main.js). This one is for normal inline templates.
     */
    _.templateSettings = {
        evaluate : /\{\[([\s\S]+?)\]\}/g,
        interpolate : /\{\{([\s\S]+?)\}\}/g
    };

    var converse = {
        plugins: {},
        initialized_plugins: [],
        templates: templates,
        emit: function (evt, data) {
            $(this).trigger(evt, data);
        },
        once: function (evt, handler) {
            $(this).one(evt, handler);
        },
        on: function (evt, handler) {
            $(this).bind(evt, handler);
        },
        off: function (evt, handler) {
            $(this).unbind(evt, handler);
        }
    };

    // Module-level constants
    converse.STATUS_WEIGHTS = {
        'offline':      6,
        'unavailable':  5,
        'xa':           4,
        'away':         3,
        'dnd':          2,
        'chat':         1, // We currently don't differentiate between "chat" and "online"
        'online':       1
    };
    converse.LOGIN = "login";
    converse.ANONYMOUS  = "anonymous";
    converse.PREBIND = "prebind";
    converse.OPENED = 'opened';
    converse.CLOSED = 'closed';

    // TODO Refactor into external MAM plugin
    // XEP-0059 Result Set Management
    var RSM_ATTRIBUTES = ['max', 'first', 'last', 'after', 'before', 'index', 'count'];
    // XEP-0313 Message Archive Management
    var MAM_ATTRIBUTES = ['with', 'start', 'end'];
    converse.queryForArchivedMessages = function (options, callback, errback) {
        /* Do a MAM (XEP-0313) query for archived messages.
            *
            * Parameters:
            *    (Object) options - Query parameters, either MAM-specific or also for Result Set Management.
            *    (Function) callback - A function to call whenever we receive query-relevant stanza.
            *    (Function) errback - A function to call when an error stanza is received.
            *
            * The options parameter can also be an instance of
            * Strophe.RSM to enable easy querying between results pages.
            *
            * The callback function may be called multiple times, first
            * for the initial IQ result and then for each message
            * returned. The last time the callback is called, a
            * Strophe.RSM object is returned on which "next" or "previous"
            * can be called before passing it in again to this method, to
            * get the next or previous page in the result set.
            */
        var date, messages = [];
        if (typeof options === "function") {
            callback = options;
            errback = callback;
        }
        if (!converse.features.findWhere({'var': Strophe.NS.MAM})) {
            throw new Error('This server does not support XEP-0313, Message Archive Management');
        }
        var queryid = converse.connection.getUniqueId();
        var attrs = {'type':'set'};
        if (typeof options !== "undefined" && options.groupchat) {
            if (!options['with']) {
                throw new Error('You need to specify a "with" value containing the chat room JID, when querying groupchat messages.');
            }
            attrs.to = options['with'];
        }
        var stanza = $iq(attrs).c('query', {'xmlns':Strophe.NS.MAM, 'queryid':queryid});
        if (typeof options !== "undefined") {
            stanza.c('x', {'xmlns':Strophe.NS.XFORM, 'type': 'submit'})
                    .c('field', {'var':'FORM_TYPE', 'type': 'hidden'})
                    .c('value').t(Strophe.NS.MAM).up().up();

            if (options['with'] && !options.groupchat) {
                stanza.c('field', {'var':'with'}).c('value').t(options['with']).up().up();
            }
            _.each(['start', 'end'], function (t) {
                if (options[t]) {
                    date = moment(options[t]);
                    if (date.isValid()) {
                        stanza.c('field', {'var':t}).c('value').t(date.format()).up().up();
                    } else {
                        throw new TypeError('archive.query: invalid date provided for: '+t);
                    }
                }
            });
            stanza.up();
            if (options instanceof Strophe.RSM) {
                stanza.cnode(options.toXML());
            } else if (_.intersection(RSM_ATTRIBUTES, _.keys(options)).length) {
                stanza.cnode(new Strophe.RSM(options).toXML());
            }
        }
        converse.connection.addHandler(function (message) {
            var $msg = $(message), $fin, rsm;
            if (typeof callback === "function") {
                $fin = $msg.find('fin[xmlns="'+Strophe.NS.MAM+'"]');
                if ($fin.length) {
                    rsm = new Strophe.RSM({xml: $fin.find('set')[0]});
                    _.extend(rsm, _.pick(options, ['max']));
                    _.extend(rsm, _.pick(options, MAM_ATTRIBUTES));
                    callback(messages, rsm);
                    return false; // We've received all messages, decommission this handler
                } else if (queryid === $msg.find('result').attr('queryid')) {
                    messages.push(message);
                }
                return true;
            } else {
                return false; // There's no callback, so no use in continuing this handler.
            }
        }, Strophe.NS.MAM);
        converse.connection.sendIQ(stanza, null, errback);
    };

    converse.initialize = function (settings, callback) {
        "use strict";
        var converse = this;
        var unloadevent;
        if ('onpagehide' in window) {
            // Pagehide gets thrown in more cases than unload. Specifically it
            // gets thrown when the page is cached and not just
            // closed/destroyed. It's the only viable event on mobile Safari.
            // https://www.webkit.org/blog/516/webkit-page-cache-ii-the-unload-event/
            unloadevent = 'pagehide';
        } else if ('onbeforeunload' in window) {
            unloadevent = 'beforeunload';
        } else if ('onunload' in window) {
            unloadevent = 'unload';
        }

        // Logging
        Strophe.log = function (level, msg) { converse.log(level+' '+msg, level); };
        Strophe.error = function (msg) { converse.log(msg, 'error'); };

        // Add Strophe Namespaces
        Strophe.addNamespace('CARBONS', 'urn:xmpp:carbons:2');
        Strophe.addNamespace('CHATSTATES', 'http://jabber.org/protocol/chatstates');
        Strophe.addNamespace('CSI', 'urn:xmpp:csi:0');
        Strophe.addNamespace('MAM', 'urn:xmpp:mam:0');
        Strophe.addNamespace('ROSTERX', 'http://jabber.org/protocol/rosterx');
        Strophe.addNamespace('RSM', 'http://jabber.org/protocol/rsm');
        Strophe.addNamespace('XFORM', 'jabber:x:data');

        // Constants
        // ---------
        var KEY = {
            ENTER: 13,
            FORWARD_SLASH: 47
        };

        var PRETTY_CONNECTION_STATUS = {
            0: 'ERROR',
            1: 'CONNECTING',
            2: 'CONNFAIL',
            3: 'AUTHENTICATING',
            4: 'AUTHFAIL',
            5: 'CONNECTED',
            6: 'DISCONNECTED',
            7: 'DISCONNECTING',
            8: 'ATTACHED',
            9: 'REDIRECT'
        };

        // XEP-0085 Chat states
        // http://xmpp.org/extensions/xep-0085.html
        var INACTIVE = 'inactive';
        var ACTIVE = 'active';
        var COMPOSING = 'composing';
        var PAUSED = 'paused';
        var GONE = 'gone';
        this.TIMEOUTS = { // Set as module attr so that we can override in tests.
            'PAUSED':     20000,
            'INACTIVE':   90000
        };

        // Detect support for the user's locale
        // ------------------------------------
        this.isConverseLocale = function (locale) { return typeof locales[locale] !== "undefined"; };
        this.isMomentLocale = function (locale) { return moment.locale() !== moment.locale(locale); };

        this.user_settings = settings; // Save the user settings so that they can be used by plugins

        this.wrappedChatBox = function (chatbox) {
            /* Wrap a chatbox for outside consumption (i.e. so that it can be
             * returned via the API.
             */
            if (!chatbox) { return; }
            var view = converse.chatboxviews.get(chatbox.get('jid'));
            return {
                'close': view.close.bind(view),
                'focus': view.focus.bind(view),
                'get': chatbox.get.bind(chatbox),
                // FIXME: leaky abstraction from MUC
                'is_chatroom': view.is_chatroom,
                'maximize': chatbox.maximize.bind(chatbox),
                'minimize': chatbox.minimize.bind(chatbox),
                'open': view.show.bind(view),
                'set': chatbox.set.bind(chatbox)
            };
        };

        this.isLocaleAvailable = function (locale, available) {
            /* Check whether the locale or sub locale (e.g. en-US, en) is supported.
             *
             * Parameters:
             *      (Function) available - returns a boolean indicating whether the locale is supported
             */
            if (available(locale)) {
                return locale;
            } else {
                var sublocale = locale.split("-")[0];
                if (sublocale !== locale && available(sublocale)) {
                    return sublocale;
                }
            }
        };
		
        this.detectLocale = function (library_check) {
            /* Determine which locale is supported by the user's system as well
             * as by the relevant library (e.g. converse.js or moment.js).
             *
             * Parameters:
             *      (Function) library_check - returns a boolean indicating whether the locale is supported
             */
            var locale, i;
            if (window.navigator.userLanguage) {
                locale = this.isLocaleAvailable(window.navigator.userLanguage, library_check);
            }
            if (window.navigator.languages && !locale) {
                for (i=0; i<window.navigator.languages.length && !locale; i++) {
                    locale = this.isLocaleAvailable(window.navigator.languages[i], library_check);
                }
            }
            if (window.navigator.browserLanguage && !locale) {
                locale = this.isLocaleAvailable(window.navigator.browserLanguage, library_check);
            }
            if (window.navigator.language && !locale) {
                locale = this.isLocaleAvailable(window.navigator.language, library_check);
            }
            if (window.navigator.systemLanguage && !locale) {
                locale = this.isLocaleAvailable(window.navigator.systemLanguage, library_check);
            }
            return locale || 'en';
        };
		
        if (!moment.locale) { //moment.lang is deprecated after 2.8.1, use moment.locale instead
            moment.locale = moment.lang;
        }
        moment.locale(this.detectLocale(this.isMomentLocale));

        // Translation machinery
        // ---------------------
        this.i18n = settings.i18n ? settings.i18n : locales.en;
        var __ = utils.__.bind(this);

        // Default configuration values
        // ----------------------------
        this.default_settings = {
            allow_chat_pending_contacts: false,
            allow_contact_removal: true,
            allow_contact_requests: true,
            allow_dragresize: true,
            allow_logout: true,
            animate: true,
            archived_messages_page_size: '20',
            authentication: 'login', // Available values are "login", "prebind", "anonymous".
            auto_away: 0, // Seconds after which user status is set to 'away'
            auto_list_rooms: false,
            auto_login: false, // Currently only used in connection with anonymous login
            auto_reconnect: false,
            auto_subscribe: false,
            auto_xa: 0, // Seconds after which user status is set to 'xa'
            bosh_service_url: undefined, // The BOSH connection manager URL.
            csi_waiting_time: 0, // Support for XEP-0352. Seconds before client is considered idle and CSI is sent out.
            debug: false,
            default_domain: undefined,
            expose_rid_and_sid: false,
            forward_messages: false,
            hide_offline_users: false,
            include_offline_state: false,
            jid: undefined,
            keepalive: false,
            locked_domain: undefined,
            message_archiving: 'never', // Supported values are 'always', 'never', 'roster' (See https://xmpp.org/extensions/xep-0313.html#prefs )
            message_carbons: false, // Support for XEP-280
            no_trimming: false, // Set to true for phantomjs tests (where browser apparently has no width)
            password: undefined,
            play_sounds: false,
            prebind: false, // XXX: Deprecated, use "authentication" instead.
            prebind_url: null,
            rid: undefined,
            roster_groups: false,
            show_only_online_users: false,
            show_toolbar: true,
            sid: undefined,
            sounds_path: '/sounds/',
            storage: 'session',
            synchronize_availability: true, // Set to false to not sync with other clients or with resource name of the particular client that it should synchronize with
            use_vcards: true,
            visible_toolbar_buttons: {
                'emoticons': true,
                'call': false,
                'clear': true,
                'toggle_occupants': true
            },
            websocket_url: undefined,
            xhr_custom_status: false,
            xhr_custom_status_url: '',
            xhr_user_search: false,
            xhr_user_search_url: ''
        };

        _.extend(this, this.default_settings);
        // Allow only whitelisted configuration attributes to be overwritten
        _.extend(this, _.pick(settings, Object.keys(this.default_settings)));

        // BBB
        if (this.prebind === true) { this.authentication = converse.PREBIND; }

        if (this.authentication === converse.ANONYMOUS) {
            if (!this.jid) {
                throw("Config Error: you need to provide the server's domain via the " +
                        "'jid' option when using anonymous authentication.");
            }
        }

        if (settings.visible_toolbar_buttons) {
            _.extend(
                this.visible_toolbar_buttons,
                _.pick(settings.visible_toolbar_buttons, [
                    'emoticons', 'call', 'clear', 'toggle_occupants'
                ]
            ));
        }
        $.fx.off = !this.animate;

        // Module-level variables
        // ----------------------
        this.callback = callback || function () {};
        /* When reloading the page:
         * For new sessions, we need to send out a presence stanza to notify
         * the server/network that we're online.
         * When re-attaching to an existing session (e.g. via the keepalive
         * option), we don't need to again send out a presence stanza, because
         * it's as if "we never left" (see onConnectStatusChanged).
         * https://github.com/jcbrand/converse.js/issues/521
         */
        this.send_initial_presence = true;
        this.msg_counter = 0;
        this.reconnectTimeout = undefined;

        // Module-level functions
        // ----------------------

        this.generateResource = function () {
            return '/converse.js-' + Math.floor(Math.random()*139749825).toString();
        };

        this.sendCSI = function (stat) {
            /* Send out a Chat Status Notification (XEP-0352) */
            if (converse.features[Strophe.NS.CSI] || true) {
                converse.connection.send($build(stat, {xmlns: Strophe.NS.CSI}));
                this.inactive = (stat === INACTIVE) ? true : false;
            }
        };

        this.onUserActivity = function () {
            /* Resets counters and flags relating to CSI and auto_away/auto_xa */
            if (this.idle_seconds > 0) {
                this.idle_seconds = 0;
            }
            if (!converse.connection.authenticated) {
                // We can't send out any stanzas when there's no authenticated connection.
                // This can happen when the connection reconnects.
                return;
            }
            if (this.inactive) {
                this.sendCSI(ACTIVE);
            }
            if (this.auto_changed_status === true) {
                this.auto_changed_status = false;
                this.xmppstatus.setStatus('online');
            }
        };

        this.onEverySecond = function () {
            /* An interval handler running every second.
             * Used for CSI and the auto_away and auto_xa
             * features.
             */
            if (!converse.connection.authenticated) {
                // We can't send out any stanzas when there's no authenticated connection.
                // This can happen when the connection reconnects.
                return;
            }
            var stat = this.xmppstatus.getStatus();
            this.idle_seconds++;
            if (this.csi_waiting_time > 0 && this.idle_seconds > this.csi_waiting_time && !this.inactive) {
                this.sendCSI(INACTIVE);
            }
            if (this.auto_away > 0 && this.idle_seconds > this.auto_away && stat !== 'away' && stat !== 'xa') {
                this.auto_changed_status = true;
                this.xmppstatus.setStatus('away');
            } else if (this.auto_xa > 0 && this.idle_seconds > this.auto_xa && stat !== 'xa') {
                this.auto_changed_status = true;
                this.xmppstatus.setStatus('xa');
            }
        };

        this.registerIntervalHandler = function () {
            /* Set an interval of one second and register a handler for it.
             * Required for the auto_away, auto_xa and csi_waiting_time features.
             */
            if (this.auto_away < 1 && this.auto_xa < 1 && this.csi_waiting_time < 1) {
                // Waiting time of less then one second means features aren't used.
                return;
            }
            this.idle_seconds = 0;
            this.auto_changed_status = false; // Was the user's status changed by converse.js?
            $(window).on('click mousemove keypress focus'+unloadevent , this.onUserActivity.bind(this));
            window.setInterval(this.onEverySecond.bind(this), 1000);
        };
		
        this.playNotification = function () {
            var audio;
            if (converse.play_sounds && typeof Audio !== "undefined") {
                audio = new Audio(converse.sounds_path+"msg_received.ogg");
                if (audio.canPlayType('/audio/ogg')) {
                    audio.play();
                } else {
                    audio = new Audio(converse.sounds_path+"msg_received.mp3");
                    audio.play();
                }
            }
        };

        this.giveFeedback = function (message, klass) {
            $('.conn-feedback').each(function (idx, el) {
                var $el = $(el);
                $el.addClass('conn-feedback').text(message);
                if (klass) {
                    $el.addClass(klass);
                } else {
                    $el.removeClass('error');
                }
            });
        };

        this.log = function (txt, level) {
            var logger;
            if (typeof console === "undefined" || typeof console.log === "undefined") {
                logger = { log: function () {}, error: function () {} };
            } else {
                logger = console;
            }
            if (this.debug) {
                if (level === 'error') {
                    logger.log('ERROR: '+txt);
                } else {
                    logger.log(txt);
                }
            }
        };

        this.rejectPresenceSubscription = function (jid, message) {
            /* Reject or cancel another user's subscription to our presence updates.
             *  Parameters:
             *    (String) jid - The Jabber ID of the user whose subscription
             *      is being canceled.
             *    (String) message - An optional message to the user
             */
            var pres = $pres({to: jid, type: "unsubscribed"});
            if (message && message !== "") { pres.c("status").t(message); }
            converse.connection.send(pres);
        };

        this.getVCard = function (jid, callback, errback) {
            /* Request the VCard of another user.
             *
             * Parameters:
             *    (String) jid - The Jabber ID of the user whose VCard is being requested.
             *    (Function) callback - A function to call once the VCard is returned
             *    (Function) errback - A function to call if an error occured
             *      while trying to fetch the VCard.
             */
            if (!this.use_vcards) {
                if (callback) { callback(jid, jid); }
                return;
            }
            converse.connection.vcard.get(
                function (iq) { // Successful callback
                    var $vcard = $(iq).find('vCard');
                    var fullname = $vcard.find('FN').text(),
                        img = $vcard.find('BINVAL').text(),
                        img_type = $vcard.find('TYPE').text(),
                        url = $vcard.find('URL').text();
                    if (jid) {
                        var contact = converse.roster.get(jid);
                        if (contact) {
                            fullname = _.isEmpty(fullname)? contact.get('fullname') || jid: fullname;
                            contact.save({
                                'fullname': fullname,
                                'image_type': img_type,
                                'image': img,
                                'url': url,
                                'vcard_updated': moment().format()
                            });
                        }
                    }
                    if (callback) { callback(iq, jid, fullname, img, img_type, url); }
                }.bind(this),
                jid,
                function (iq) { // Error callback
                    var contact = converse.roster.get(jid);
                    if (contact) {
                        contact.save({ 'vcard_updated': moment().format() });
                    }
                    if (errback) { errback(iq, jid); }
                }
            );
        };

        this.reconnect = function (condition) {
            converse.log('Attempting to reconnect in 5 seconds');
            converse.giveFeedback(__('Attempting to reconnect in 5 seconds'), 'error');
            window.clearTimeout(converse.reconnectTimeout);
            converse.reconnectTimeout = window.setTimeout(function () {
                if (converse.authentication !== "prebind") {
                    this.connection.connect(
                        this.connection.jid,
                        this.connection.pass,
                        function (status, condition) {
                            this.onConnectStatusChanged(status, condition, true);
                        }.bind(this),
                        this.connection.wait,
                        this.connection.hold,
                        this.connection.route
                    );
                } else if (converse.prebind_url) {
                    this.clearSession();
                    this._tearDown();
                    this.startNewBOSHSession();
                }
            }.bind(this), 5000);
        };

        this.onConnectStatusChanged = function (status, condition, reconnect) {
            converse.log("Status changed to: "+PRETTY_CONNECTION_STATUS[status]);
            if (status === Strophe.Status.CONNECTED || status === Strophe.Status.ATTACHED) {
                // By default we always want to send out an initial presence stanza.
                converse.send_initial_presence = true;
                delete converse.disconnection_cause;
                if (!!converse.reconnectTimeout) {
                    window.clearTimeout(converse.reconnectTimeout);
                    delete converse.reconnectTimeout;
                }
                if ((typeof reconnect !== 'undefined') && (reconnect)) {
                    converse.log(status === Strophe.Status.CONNECTED ? 'Reconnected' : 'Reattached');
                    converse.onReconnected();
                } else {
                    converse.log(status === Strophe.Status.CONNECTED ? 'Connected' : 'Attached');
                    if (converse.connection.restored) {
                        converse.send_initial_presence = false; // No need to send an initial presence stanza when
                                                                // we're restoring an existing session.
                    }
                    converse.onConnected();
                }
            } else if (status === Strophe.Status.DISCONNECTED) {
                if (converse.disconnection_cause === Strophe.Status.CONNFAIL && converse.auto_reconnect) {
                    converse.reconnect(condition);
                } else {
                    converse.renderLoginPanel();
                }
            } else if (status === Strophe.Status.ERROR) {
                converse.giveFeedback(__('Error'), 'error');
            } else if (status === Strophe.Status.CONNECTING) {
                converse.giveFeedback(__('Connecting'));
            } else if (status === Strophe.Status.AUTHENTICATING) {
                converse.giveFeedback(__('Authenticating'));
            } else if (status === Strophe.Status.AUTHFAIL) {
                converse.giveFeedback(__('Authentication Failed'), 'error');
                converse.connection.disconnect(__('Authentication Failed'));
                converse.disconnection_cause = Strophe.Status.AUTHFAIL;
            } else if (status === Strophe.Status.CONNFAIL) {
                converse.disconnection_cause = Strophe.Status.CONNFAIL;
            } else if (status === Strophe.Status.DISCONNECTING) {
                // FIXME: what about prebind?
                if (!converse.connection.connected) {
                    converse.renderLoginPanel();
                }
                if (condition) {
                    converse.giveFeedback(condition, 'error');
                }
            }
        };

        this.applyDragResistance = function (value, default_value) {
            /* This method applies some resistance around the
             * default_value. If value is close enough to
             * default_value, then default_value is returned instead.
             */
            if (typeof value === 'undefined') {
                return undefined;
            } else if (typeof default_value === 'undefined') {
                return value;
            }
            var resistance = 10;
            if ((value !== default_value) &&
                (Math.abs(value- default_value) < resistance)) {
                return default_value;
            }
            return value;
        };

        this.updateMsgCounter = function () {
            if (this.msg_counter > 0) {
                if (document.title.search(/^Messages \(\d+\) /) === -1) {
                    document.title = "Messages (" + this.msg_counter + ") " + document.title;
                } else {
                    document.title = document.title.replace(/^Messages \(\d+\) /, "Messages (" + this.msg_counter + ") ");
                }
                window.blur();
                window.focus();
            } else if (document.title.search(/^Messages \(\d+\) /) !== -1) {
                document.title = document.title.replace(/^Messages \(\d+\) /, "");
            }
        };

        this.incrementMsgCounter = function () {
            this.msg_counter += 1;
            this.updateMsgCounter();
        };

        this.clearMsgCounter = function () {
            this.msg_counter = 0;
            this.updateMsgCounter();
        };

        this.initStatus = function (callback) {
            this.xmppstatus = new this.XMPPStatus();
            var id = b64_sha1('converse.xmppstatus-'+converse.bare_jid);
            this.xmppstatus.id = id; // Appears to be necessary for backbone.browserStorage
            this.xmppstatus.browserStorage = new Backbone.BrowserStorage[converse.storage](id);
            this.xmppstatus.fetch({success: callback, error: callback});
        };

        this.initSession = function () {
            this.session = new this.Session();
            var id = b64_sha1('converse.bosh-session');
            this.session.id = id; // Appears to be necessary for backbone.browserStorage
            this.session.browserStorage = new Backbone.BrowserStorage[converse.storage](id);
            this.session.fetch();
        };

        this.clearSession = function () {
            if (this.roster) {
                this.roster.browserStorage._clear();
            }
            this.session.browserStorage._clear();
        };

        this.logOut = function () {
            converse.auto_login = false;
            converse.chatboxviews.closeAllChatBoxes();
            converse.clearSession();
            converse.connection.disconnect();
        };

        this.registerGlobalEventHandlers = function () {
            $(document).on('mousemove', function (ev) {
                if (!this.resizing || !this.allow_dragresize) { return true; }
                ev.preventDefault();
                this.resizing.chatbox.resizeChatBox(ev);
            }.bind(this));

            $(document).on('mouseup', function (ev) {
                if (!this.resizing || !this.allow_dragresize) { return true; }
                ev.preventDefault();
                var height = this.applyDragResistance(
                        this.resizing.chatbox.height,
                        this.resizing.chatbox.model.get('default_height')
                );
                var width = this.applyDragResistance(
                        this.resizing.chatbox.width,
                        this.resizing.chatbox.model.get('default_width')
                );
                if (this.connection.connected) {
                    this.resizing.chatbox.model.save({'height': height});
                    this.resizing.chatbox.model.save({'width': width});
                } else {
                    this.resizing.chatbox.model.set({'height': height});
                    this.resizing.chatbox.model.set({'width': width});
                }
                this.resizing = null;
            }.bind(this));

            $(window).on("blur focus", function (ev) {
                if ((this.windowState !== ev.type) && (ev.type === 'focus')) {
                    converse.clearMsgCounter();
                }
                this.windowState = ev.type;
            }.bind(this));

            $(window).on("resize", _.debounce(function (ev) {
                this.chatboxviews.trimChats();
            }.bind(this), 200));
        };

        this.onReconnected = function () {
            // We need to re-register all the event handlers on the newly
            // created connection.
            var deferred = new $.Deferred();
            this.initStatus(function () {
                this.rosterview.registerRosterXHandler();
                this.rosterview.registerPresenceHandler();
                this.chatboxes.registerMessageHandler();
                this.xmppstatus.sendPresence();
                this.giveFeedback(__('Contacts'));
                deferred.resolve();
            }.bind(this));
            return deferred.promise();
        };

        this.enableCarbons = function () {
            /* Ask the XMPP server to enable Message Carbons
             * See XEP-0280 https://xmpp.org/extensions/xep-0280.html#enabling
             */
            if (!this.message_carbons || this.session.get('carbons_enabled')) {
                return;
            }
            var carbons_iq = new Strophe.Builder('iq', {
                from: this.connection.jid,
                id: 'enablecarbons',
                type: 'set'
              })
              .c('enable', {xmlns: Strophe.NS.CARBONS});
            this.connection.addHandler(function (iq) {
                if ($(iq).find('error').length > 0) {
                    converse.log('ERROR: An error occured while trying to enable message carbons.');
                } else {
                    this.session.save({carbons_enabled: true});
                    converse.log('Message carbons have been enabled.');
                }
            }.bind(this), null, "iq", null, "enablecarbons");
            this.connection.send(carbons_iq);
        };

        this.onConnected = function (callback) {
            // When reconnecting, there might be some open chat boxes. We don't
            // know whether these boxes are of the same account or not, so we
            // close them now.
            var deferred = new $.Deferred();
            this.chatboxviews.closeAllChatBoxes();
            this.jid = this.connection.jid;
            this.bare_jid = Strophe.getBareJidFromJid(this.connection.jid);
            this.resource = Strophe.getResourceFromJid(this.connection.jid);
            this.domain = Strophe.getDomainFromJid(this.connection.jid);
            this.minimized_chats = new converse.MinimizedChats({model: this.chatboxes});
            this.features = new this.Features();
            this.enableCarbons();
            this.initStatus(function () {
                this.registerIntervalHandler();				
                this.chatboxes.onConnected();
                this.giveFeedback(__('Contacts'));
                if (typeof this.callback === 'function') {
                    // A callback method may be passed in via the
                    // converse.initialize method.
                    // XXX: Can we use $.Deferred instead of this callback?
                    if (this.connection.service === 'jasmine tests') {
                        // XXX: Call back with the internal converse object. This
                        // object should never be exposed to production systems.
                        // 'jasmine tests' is an invalid http bind service value,
                        // so we're sure that this is just for tests.
                        this.callback(this);
                    } else  {
                        this.callback();
                    }
                }
                deferred.resolve();
            }.bind(this));
            converse.emit('ready');
            return deferred.promise();
        };

        this.Message = Backbone.Model.extend({
            idAttribute: 'msgid',
            defaults: function(){
                return {
                    msgid: converse.connection.getUniqueId()
                };
            }
        });
        this.Messages = Backbone.Collection.extend({
            model: converse.Message,
            comparator: 'time'
        });

        this.ChatBox = Backbone.Model.extend({

            initialize: function () {
                this.messages = new converse.Messages();
                this.messages.browserStorage = new Backbone.BrowserStorage[converse.storage](
                    b64_sha1('converse.messages'+this.get('jid')+converse.bare_jid));
                this.save(_.extend(this.getDefaultSettings(), {
                    // The chat_state will be set to ACTIVE once the chat box is opened
                    // and we listen for change:chat_state, so shouldn't set it to ACTIVE here.
                    'chat_state': undefined,
                    'box_id' : b64_sha1(this.get('jid')),
                    'minimized': this.get('minimized') || false,
                    'time_minimized': this.get('time_minimized') || moment(),
                    'time_opened': this.get('time_opened') || moment().valueOf(),
                    'url': '',
                    'user_id' : Strophe.getNodeFromJid(this.get('jid'))
                }));
            },

            getDefaultSettings: function () {
                var height = this.get('height'),
                    width = this.get('width');
                return {
                    'height': converse.applyDragResistance(height, this.get('default_height')),
                    'width': converse.applyDragResistance(width, this.get('default_width')),
                    'num_unread': this.get('num_unread') || 0
                };
            },

            maximize: function () {
                this.save({
                    'minimized': false,
                    'time_opened': moment().valueOf()
                });
            },

            minimize: function () {
                this.save({
                    'minimized': true,
                    'time_minimized': moment().format()
                });
            },

            isOnlyChatStateNotification: function ($msg) {
                // See XEP-0085 Chat State Notification
                return (
                    $msg.find('body').length === 0 && (
                        $msg.find(ACTIVE).length !== 0 ||
                        $msg.find(COMPOSING).length !== 0 ||
                        $msg.find(INACTIVE).length !== 0 ||
                        $msg.find(PAUSED).length !== 0 ||
                        $msg.find(GONE).length !== 0
                    )
                );
            },

            shouldPlayNotification: function ($message) {
                var $forwarded = $message.find('forwarded');
                if ($forwarded.length) {
                    return false;
                }
                var is_me = Strophe.getBareJidFromJid($message.attr('from')) === converse.bare_jid;
                return !this.isOnlyChatStateNotification($message) && !is_me;
            },

            createMessage: function ($message, $delay, archive_id) {
                $delay = $delay || $message.find('delay');
                var body = $message.children('body').text(),
                    delayed = $delay.length > 0,
                    fullname = this.get('fullname'),
                    is_groupchat = $message.attr('type') === 'groupchat',
                    msgid = $message.attr('id'),
                    chat_state = $message.find(COMPOSING).length && COMPOSING ||
                        $message.find(PAUSED).length && PAUSED ||
                        $message.find(INACTIVE).length && INACTIVE ||
                        $message.find(ACTIVE).length && ACTIVE ||
                        $message.find(GONE).length && GONE,
                    stamp, time, sender, from;

                if (is_groupchat) {
                    from = Strophe.unescapeNode(Strophe.getResourceFromJid($message.attr('from')));
                } else {
                    from = Strophe.getBareJidFromJid($message.attr('from'));
                }
                fullname = (_.isEmpty(fullname) ? from: fullname).split(' ')[0];
                if (delayed) {
                    stamp = $delay.attr('stamp');
                    time = stamp;
                } else {
                    time = moment().format();
                }
                if ((is_groupchat && from === this.get('nick')) || (!is_groupchat && from === converse.bare_jid)) {
                    sender = 'me';
                } else {
                    sender = 'them';
                }
                this.messages.create({
                    chat_state: chat_state,
                    delayed: delayed,
                    fullname: fullname,
                    message: body || undefined,
                    msgid: msgid,
                    sender: sender,
                    time: time,
                    archive_id: archive_id
                });
            }
        });

        this.ChatBoxView = Backbone.View.extend({
            length: 200,
            tagName: 'div',
            className: 'chatbox',
            is_chatroom: false,  // This is not a multi-user chatroom

            events: {
                'click .close-chatbox-button': 'close',
                'click .toggle-chatbox-button': 'minimize',
                'keypress textarea.chat-textarea': 'keyPressed',
                'click .toggle-smiley': 'toggleEmoticonMenu',
                'click .toggle-smiley ul li': 'insertEmoticon',
                'click .toggle-clear': 'clearMessages',
                'click .toggle-call': 'toggleCall',
                'mousedown .dragresize-top': 'onStartVerticalResize',
                'mousedown .dragresize-left': 'onStartHorizontalResize',
                'mousedown .dragresize-topleft': 'onStartDiagonalResize'
            },

            initialize: function () {
                $(window).on('resize', _.debounce(this.setDimensions.bind(this), 100));
                this.model.messages.on('add', this.onMessageAdded, this);
                this.model.on('show', this.show, this);
                this.model.on('destroy', this.hide, this);
                // TODO check for changed fullname as well
                this.model.on('change:chat_state', this.sendChatState, this);
                this.model.on('change:chat_status', this.onChatStatusChanged, this);
                this.model.on('change:image', this.renderAvatar, this);
                this.model.on('change:minimized', this.onMinimizedChanged, this);
                this.model.on('change:status', this.onStatusChanged, this);
                this.model.on('showHelpMessages', this.showHelpMessages, this);
                this.model.on('sendMessage', this.sendMessage, this);
                this.updateVCard().render().fetchMessages().insertIntoPage().hide();
            },

            render: function () {
                this.$el.attr('id', this.model.get('box_id'))
                    .html(converse.templates.chatbox(
                            _.extend(this.model.toJSON(), {
                                    show_toolbar: converse.show_toolbar,
                                    info_close: __('Close this chat box'),
                                    info_minimize: __('Minimize this chat box'),
                                    info_view: __('View more information on this person'),
                                    label_personal_message: __('Personal message')
                                }
                            )
                        )
                    );
                this.setWidth();
                this.$content = this.$el.find('.chat-content');
                this.renderToolbar().renderAvatar();
                this.$content.on('scroll', _.debounce(this.onScroll.bind(this), 100));
                converse.emit('chatBoxOpened', this);
                window.setTimeout(utils.refreshWebkit, 50);
                return this.showStatusMessage();
            },

            setWidth: function () {
                // If a custom width is applied (due to drag-resizing),
                // then we need to set the width of the .chatbox element as well.
                if (this.model.get('width')) {
                    this.$el.css('width', this.model.get('width'));
                }
            },

            onScroll: function (ev) {
                if ($(ev.target).scrollTop() === 0 && this.model.messages.length) {
                    this.fetchArchivedMessages({
                        'before': this.model.messages.at(0).get('archive_id'),
                        'with': this.model.get('jid'),
                        'max': converse.archived_messages_page_size
                    });
                }
            },

            fetchMessages: function () {
                /* Responsible for fetching previously sent messages, first
                 * from session storage, and then once that's done by calling
                 * fetchArchivedMessages, which fetches from the XMPP server if
                 * applicable.
                 */
                this.model.messages.fetch({
                    'add': true,
                    'success': function () {
                            if (!converse.features.findWhere({'var': Strophe.NS.MAM})) {
                                return;
                            }
                            if (this.model.messages.length < converse.archived_messages_page_size) {
                                this.fetchArchivedMessages({
                                    'before': '', // Page backwards from the most recent message
                                    'with': this.model.get('jid'),
                                    'max': converse.archived_messages_page_size
                                });
                            }
                        }.bind(this)
                });
                return this;
            },

            fetchArchivedMessages: function (options) {
                /* Fetch archived chat messages from the XMPP server.
                 *
                 * Then, upon receiving them, call onMessage on the chat box,
                 * so that they are displayed inside it.
                 */
                if (!converse.features.findWhere({'var': Strophe.NS.MAM})) {
                    converse.log("Attempted to fetch archived messages but this user's server doesn't support XEP-0313");
                    return;
                }
                this.addSpinner();
                converse.queryForArchivedMessages(options, function (messages) {
                        this.clearSpinner();
                        if (messages.length) {
                            _.map(messages, converse.chatboxes.onMessage.bind(converse.chatboxes));
                        }
                    }.bind(this),
                    function () {
                        this.clearSpinner();
                        converse.log("Error while trying to fetch archived messages", "error");
                    }.bind(this)
                );
            },

            insertIntoPage: function () {
                /* This method gets overridden in src/converse-controlbox.js if
                 * the controlbox plugin is active.
                 */
                $('#conversejs').prepend(this.$el);
                return this;
            },

            adjustToViewport: function () {
                /* Event handler called when viewport gets resized. We remove
                 * custom width/height from chat boxes.
                 */
                var viewport_width = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
                var viewport_height = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
                if (viewport_width <= 480) {
                    this.model.set('height', undefined);
                    this.model.set('width', undefined);
                } else if (viewport_width <= this.model.get('width')) {
                    this.model.set('width', undefined);
                } else if (viewport_height <= this.model.get('height')) {
                    this.model.set('height', undefined);
                }
            },

            initDragResize: function () {
                /* Determine and store the default box size.
                 * We need this information for the drag-resizing feature.
                 */
                var $flyout = this.$el.find('.box-flyout');
                if (typeof this.model.get('height') === 'undefined') {
                    var height = $flyout.height();
                    var width = $flyout.width();
                    this.model.set('height', height);
                    this.model.set('default_height', height);
                    this.model.set('width', width);
                    this.model.set('default_width', width);
                }
                var min_width = $flyout.css('min-width');
                var min_height = $flyout.css('min-height');
                this.model.set('min_width', min_width.endsWith('px') ? Number(min_width.replace(/px$/, '')) :0);
                this.model.set('min_height', min_height.endsWith('px') ? Number(min_height.replace(/px$/, '')) :0);
                // Initialize last known mouse position
                this.prev_pageY = 0;
                this.prev_pageX = 0;
                if (converse.connection.connected) {
                    this.height = this.model.get('height');
                    this.width = this.model.get('width');
                }
                return this;
            },

            setDimensions: function () {
                // Make sure the chat box has the right height and width.
                this.adjustToViewport();
                this.setChatBoxHeight(this.model.get('height'));
                this.setChatBoxWidth(this.model.get('width'));
            },

            clearStatusNotification: function () {
                this.$content.find('div.chat-event').remove();
            },

            showStatusNotification: function (message, keep_old) {
                if (!keep_old) {
                    this.clearStatusNotification();
                }
                var was_at_bottom = this.$content.scrollTop() + this.$content.innerHeight() >= this.$content[0].scrollHeight;
                this.$content.append($('<div class="chat-info chat-event"></div>').text(message));
                if (was_at_bottom) {
                    this.scrollDown();
                }
            },

            addSpinner: function () {
                if (!this.$content.first().hasClass('spinner')) {
                    this.$content.prepend('<span class="spinner"/>');
                }
            },

            clearSpinner: function () {
                if (this.$content.children(':first').is('span.spinner')) {
                    this.$content.children(':first').remove();
                }
            },

            prependDayIndicator: function (date) {
                /* Prepends an indicator into the chat area, showing the day as
                 * given by the passed in date.
                 *
                 * Parameters:
                 *  (String) date - An ISO8601 date string.
                 */
                var day_date = moment(date).startOf('day');
                this.$content.prepend(converse.templates.new_day({
                    isodate: day_date.format(),
                    datestring: day_date.format("dddd MMM Do YYYY")
                }));
            },

            appendMessage: function (attrs) {
                /* Helper method which appends a message to the end of the chat
                 * box's content area.
                 *
                 * Parameters:
                 *  (Object) attrs: An object containing the message attributes.
                 */
                _.compose(
                    _.debounce(this.scrollDown.bind(this), 50),
                    this.$content.append.bind(this.$content)
                )(this.renderMessage(attrs));
            },

            showMessage: function (attrs) {
                /* Inserts a chat message into the content area of the chat box.
                 * Will also insert a new day indicator if the message is on a
                 * different day.
                 *
                 * The message to show may either be newer than the newest
                 * message, or older than the oldest message.
                 *
                 * Parameters:
                 *  (Object) attrs: An object containing the message attributes.
                 */
                var $first_msg = this.$content.children('.chat-message:first'),
                    first_msg_date = $first_msg.data('isodate'),
                    last_msg_date, current_msg_date, day_date, $msgs, msg_dates, idx;
                if (!first_msg_date) {
                    this.appendMessage(attrs);
                    return;
                }
                current_msg_date = moment(attrs.time) || moment;
                last_msg_date = this.$content.children('.chat-message:last').data('isodate');

                if (typeof last_msg_date !== "undefined" && (current_msg_date.isAfter(last_msg_date) || current_msg_date.isSame(last_msg_date))) {
                    // The new message is after the last message
                    if (current_msg_date.isAfter(last_msg_date, 'day')) {
                        // Append a new day indicator
                        day_date = moment(current_msg_date).startOf('day');
                        this.$content.append(converse.templates.new_day({
                            isodate: current_msg_date.format(),
                            datestring: current_msg_date.format("dddd MMM Do YYYY")
                        }));
                    }
                    this.appendMessage(attrs);
                    return;
                }

                if (typeof first_msg_date !== "undefined" &&
                        (current_msg_date.isBefore(first_msg_date) ||
                            (current_msg_date.isSame(first_msg_date) && !current_msg_date.isSame(last_msg_date)))) {
                    // The new message is before the first message

                    if ($first_msg.prev().length === 0) {
                        // There's no day indicator before the first message, so we prepend one.
                        this.prependDayIndicator(first_msg_date);
                    }
                    if (current_msg_date.isBefore(first_msg_date, 'day')) {
                        _.compose(
                                this.scrollDownMessageHeight.bind(this),
                                function ($el) {
                                    this.$content.prepend($el);
                                    return $el;
                                }.bind(this)
                            )(this.renderMessage(attrs));
                        // This message is on a different day, so we add a day indicator.
                        this.prependDayIndicator(current_msg_date);
                    } else {
                        // The message is before the first, but on the same day.
                        // We need to prepend the message immediately before the
                        // first message (so that it'll still be after the day indicator).
                        _.compose(
                                this.scrollDownMessageHeight.bind(this),
                                function ($el) {
                                    $el.insertBefore($first_msg);
                                    return $el;
                                }
                            )(this.renderMessage(attrs));
                    }
                } else {
                    // We need to find the correct place to position the message
                    current_msg_date = current_msg_date.format();
                    $msgs = this.$content.children('.chat-message');
                    msg_dates = _.map($msgs, function (el) {
                        return $(el).data('isodate');
                    });
                    msg_dates.push(current_msg_date);
                    msg_dates.sort();
                    idx = msg_dates.indexOf(current_msg_date)-1;
                    _.compose(
                            this.scrollDownMessageHeight.bind(this),
                            function ($el) {
                                $el.insertAfter(this.$content.find('.chat-message[data-isodate="'+msg_dates[idx]+'"]'));
                                return $el;
                            }.bind(this)
                        )(this.renderMessage(attrs));
                }
            },

            renderMessage: function (attrs) {
                /* Renders a chat message based on the passed in attributes.
                 *
                 * Parameters:
                 *  (Object) attrs: An object containing the message attributes.
                 *
                 *  Returns:
                 *      The DOM element representing the message.
                 */
                var msg_time = moment(attrs.time) || moment,
                    text = attrs.message,
                    match = text.match(/^\/(.*?)(?: (.*))?$/),
                    fullname = this.model.get('fullname') || attrs.fullname,
                    extra_classes = attrs.delayed && 'delayed' || '',
                    template, username;

                if ((match) && (match[1] === 'me')) {
                    text = text.replace(/^\/me/, '');
                    template = converse.templates.action;
                    username = fullname;
                } else  {
                    template = converse.templates.message;
                    username = attrs.sender === 'me' && __('me') || fullname;
                }
                this.$content.find('div.chat-event').remove();

                // FIXME: leaky abstraction from MUC
                if (this.is_chatroom && attrs.sender === 'them' && (new RegExp("\\b"+this.model.get('nick')+"\\b")).test(text)) {
                    // Add special class to mark groupchat messages in which we
                    // are mentioned.
                    extra_classes += ' mentioned';
                }
                return $(template({
                        msgid: attrs.msgid,
                        'sender': attrs.sender,
                        'time': msg_time.format('hh:mm'),
                        'isodate': msg_time.format(),
                        'username': username,
                        'message': '',
                        'extra_classes': extra_classes
                    })).children('.chat-msg-content').first().text(text)
                        .addHyperlinks()
                        .addEmoticons(converse.visible_toolbar_buttons.emoticons).parent();
            },

            showHelpMessages: function (msgs, type, spinner) {
                var i, msgs_length = msgs.length;
                for (i=0; i<msgs_length; i++) {
                    this.$content.append($('<div class="chat-'+(type||'info')+'">'+msgs[i]+'</div>'));
                }
                if (spinner === true) {
                    this.$content.append('<span class="spinner"/>');
                } else if (spinner === false) {
                    this.$content.find('span.spinner').remove();
                }
                return this.scrollDown();
            },

            onMessageAdded: function (message) {
                /* Handler that gets called when a new message object is created.
                 *
                 * Parameters:
                 *    (Object) message - The message Backbone object that was added.
                 */
                if (typeof this.clear_status_timeout !== 'undefined') {
                    window.clearTimeout(this.clear_status_timeout);
                    delete this.clear_status_timeout;
                }
                if (!message.get('message')) {
                    if (message.get('chat_state') === COMPOSING) {
                        this.showStatusNotification(message.get('fullname')+' '+__('is typing'));
                        this.clear_status_timeout = window.setTimeout(this.clearStatusNotification.bind(this), 10000);
                        return;
                    } else if (message.get('chat_state') === PAUSED) {
                        this.showStatusNotification(message.get('fullname')+' '+__('has stopped typing'));
                        return;
                    } else if (_.contains([INACTIVE, ACTIVE], message.get('chat_state'))) {
                        this.$content.find('div.chat-event').remove();
                        return;
                    } else if (message.get('chat_state') === GONE) {
                        this.showStatusNotification(message.get('fullname')+' '+__('has gone away'));
                        return;
                    }
                } else {
                    this.showMessage(_.clone(message.attributes));
                }
                if ((message.get('sender') !== 'me') && (converse.windowState === 'blur')) {
                    converse.incrementMsgCounter();
                }
                if (!this.model.get('minimized') && !this.$el.is(':visible')) {
                    this.show();
                }
            },

            createMessageStanza: function (message) {
                return $msg({
                            from: converse.connection.jid,
                            to: this.model.get('jid'),
                            type: 'chat',
                            id: message.get('msgid')
                       }).c('body').t(message.get('message')).up()
                         .c(ACTIVE, {'xmlns': Strophe.NS.CHATSTATES}).up();
            },

            sendMessage: function (message) {
                /* Responsible for sending off a text message.
                 *
                 *  Parameters:
                 *    (Message) message - The chat message
                 */
                // TODO: We might want to send to specfic resources.
                // Especially in the OTR case.
                var messageStanza = this.createMessageStanza(message);
                converse.connection.send(messageStanza);
                if (converse.forward_messages) {
                    // Forward the message, so that other connected resources are also aware of it.
                    converse.connection.send(
                        $msg({ to: converse.bare_jid, type: 'chat', id: message.get('msgid') })
                        .c('forwarded', {xmlns:'urn:xmpp:forward:0'})
                        .c('delay', {xmns:'urn:xmpp:delay',stamp:(new Date()).getTime()}).up()
                        .cnode(messageStanza.tree())
                    );
                }
            },

            onMessageSubmitted: function (text) {
                /* This method gets called once the user has typed a message
                 * and then pressed enter in a chat box.
                 *
                 *  Parameters:
                 *    (string) text - The chat message text.
                 */
                if (!converse.connection.authenticated) {
                    return this.showHelpMessages(
                        ['Sorry, the connection has been lost, '+
                            'and your message could not be sent'],
                        'error'
                    );
                }
                var match = text.replace(/^\s*/, "").match(/^\/(.*)\s*$/), msgs;
                if (match) {
                    if (match[1] === "clear") {
                        return this.clearMessages();
                    }
                    else if (match[1] === "help") {
                        msgs = [
                            '<strong>/help</strong>:'+__('Show this menu')+'',
                            '<strong>/me</strong>:'+__('Write in the third person')+'',
                            '<strong>/clear</strong>:'+__('Remove messages')+''
                            ];
                        this.showHelpMessages(msgs);
                        return;
                    }
                }
                var fullname = converse.xmppstatus.get('fullname');
                fullname = _.isEmpty(fullname)? converse.bare_jid: fullname;
                var message = this.model.messages.create({
                    fullname: fullname,
                    sender: 'me',
                    time: moment().format(),
                    message: text
                });
                this.sendMessage(message);
            },

            sendChatState: function () {
                /* Sends a message with the status of the user in this chat session
                 * as taken from the 'chat_state' attribute of the chat box.
                 * See XEP-0085 Chat State Notifications.
                 */
                converse.connection.send(
                    $msg({'to':this.model.get('jid'), 'type': 'chat'})
                        .c(this.model.get('chat_state'), {'xmlns': Strophe.NS.CHATSTATES})
                );
            },

            setChatState: function (state, no_save) {
                /* Mutator for setting the chat state of this chat session.
                 * Handles clearing of any chat state notification timeouts and
                 * setting new ones if necessary.
                 * Timeouts are set when the  state being set is COMPOSING or PAUSED.
                 * After the timeout, COMPOSING will become PAUSED and PAUSED will become INACTIVE.
                 * See XEP-0085 Chat State Notifications.
                 *
                 *  Parameters:
                 *    (string) state - The chat state (consts ACTIVE, COMPOSING, PAUSED, INACTIVE, GONE)
                 *    (Boolean) no_save - Just do the cleanup or setup but don't actually save the state.
                 */
                if (typeof this.chat_state_timeout !== 'undefined') {
                    window.clearTimeout(this.chat_state_timeout);
                    delete this.chat_state_timeout;
                }
                if (state === COMPOSING) {
                    this.chat_state_timeout = window.setTimeout(
                            this.setChatState.bind(this), converse.TIMEOUTS.PAUSED, PAUSED);
                } else if (state === PAUSED) {
                    this.chat_state_timeout = window.setTimeout(
                            this.setChatState.bind(this), converse.TIMEOUTS.INACTIVE, INACTIVE);
                }
                if (!no_save && this.model.get('chat_state') !== state) {
                    this.model.set('chat_state', state);
                }
                return this;
            },

            keyPressed: function (ev) {
                /* Event handler for when a key is pressed in a chat box textarea.
                 */
                var $textarea = $(ev.target), message;
                if (ev.keyCode === KEY.ENTER) {
                    ev.preventDefault();
                    message = $textarea.val();
                    $textarea.val('').focus();
                    if (message !== '') {
                        if (this.model.get('chatroom')) {
                            this.onChatRoomMessageSubmitted(message);
                        } else {
                            this.onMessageSubmitted(message);
                        }
                        converse.emit('messageSend', message);
                    }
                    this.setChatState(ACTIVE);
                } else if (!this.model.get('chatroom')) { // chat state data is currently only for single user chat
                    // Set chat state to composing if keyCode is not a forward-slash
                    // (which would imply an internal command and not a message).
                    this.setChatState(COMPOSING, ev.keyCode === KEY.FORWARD_SLASH);
                }
            },

            onStartVerticalResize: function (ev) {
                if (!converse.allow_dragresize) { return true; }
                // Record element attributes for mouseMove().
                this.height = this.$el.children('.box-flyout').height();
                converse.resizing = {
                    'chatbox': this,
                    'direction': 'top'
                };
                this.prev_pageY = ev.pageY;
            },

            onStartHorizontalResize: function (ev) {
                if (!converse.allow_dragresize) { return true; }
                this.width = this.$el.children('.box-flyout').width();
                converse.resizing = {
                    'chatbox': this,
                    'direction': 'left'
                };
                this.prev_pageX = ev.pageX;
            },

            onStartDiagonalResize: function (ev) {
                this.onStartHorizontalResize(ev);
                this.onStartVerticalResize(ev);
                converse.resizing.direction = 'topleft';
            },

            setChatBoxHeight: function (height) {
                if (!this.model.get('minimized')) {
                    if (height) {
                        height = converse.applyDragResistance(height, this.model.get('default_height'))+'px';
                    } else {
                        height = "";
                    }
                    this.$el.children('.box-flyout')[0].style.height = height;
                }
            },

            setChatBoxWidth: function (width) {
                if (!this.model.get('minimized')) {
                    if (width) {
                        width = converse.applyDragResistance(width, this.model.get('default_width'))+'px';
                    } else {
                        width = "";
                    }
                    this.$el[0].style.width = width;
                    this.$el.children('.box-flyout')[0].style.width = width;
                }
            },

            resizeChatBox: function (ev) {
                var diff;
                if (converse.resizing.direction.indexOf('top') === 0) {
                    diff = ev.pageY - this.prev_pageY;
                    if (diff) {
                        this.height = ((this.height-diff) > (this.model.get('min_height') || 0)) ? (this.height-diff) : this.model.get('min_height');
                        this.prev_pageY = ev.pageY;
                        this.setChatBoxHeight(this.height);
                    }
                }
                if (converse.resizing.direction.indexOf('left') !== -1) {
                    diff = this.prev_pageX - ev.pageX;
                    if (diff) {
                        this.width = ((this.width+diff) > (this.model.get('min_width') || 0)) ? (this.width+diff) : this.model.get('min_width');
                        this.prev_pageX = ev.pageX;
                        this.setChatBoxWidth(this.width);
                    }
                }
            },

            clearMessages: function (ev) {
                if (ev && ev.preventDefault) { ev.preventDefault(); }
                var result = confirm(__("Are you sure you want to clear the messages from this chat box?"));
                if (result === true) {
                    this.$content.empty();
                    this.model.messages.reset();
                    this.model.messages.browserStorage._clear();
                }
                return this;
            },

            insertEmoticon: function (ev) {
                ev.stopPropagation();
                this.$el.find('.toggle-smiley ul').slideToggle(200);
                var $textbox = this.$el.find('textarea.chat-textarea');
                var value = $textbox.val();
                var $target = $(ev.target);
                $target = $target.is('a') ? $target : $target.children('a');
                if (value && (value[value.length-1] !== ' ')) {
                    value = value + ' ';
                }
                $textbox.focus().val(value+$target.data('emoticon')+' ');
            },

            toggleEmoticonMenu: function (ev) {
                ev.stopPropagation();
                this.$el.find('.toggle-smiley ul').slideToggle(200);
            },

            toggleCall: function (ev) {
                ev.stopPropagation();
                converse.emit('callButtonClicked', {
                    connection: converse.connection,
                    model: this.model
                });
            },

            onChatStatusChanged: function (item) {
                var chat_status = item.get('chat_status'),
                    fullname = item.get('fullname');
                fullname = _.isEmpty(fullname)? item.get('jid'): fullname;
                if (this.$el.is(':visible')) {
                    if (chat_status === 'offline') {
                        this.showStatusNotification(fullname+' '+__('has gone offline'));
                    } else if (chat_status === 'away') {
                        this.showStatusNotification(fullname+' '+__('has gone away'));
                    } else if ((chat_status === 'dnd')) {
                        this.showStatusNotification(fullname+' '+__('is busy'));
                    } else if (chat_status === 'online') {
                        this.$el.find('div.chat-event').remove();
                    }
                }
                converse.emit('contactStatusChanged', item.attributes, item.get('chat_status'));
            },

            onStatusChanged: function (item) {
                this.showStatusMessage();
                converse.emit('contactStatusMessageChanged', item.attributes, item.get('status'));
            },

            onMinimizedChanged: function (item) {
                if (item.get('minimized')) {
                    this.hide();
                } else {
                    this.maximize();
                }
            },

            showStatusMessage: function (msg) {
                msg = msg || this.model.get('status');
                if (typeof msg === "string") {
                    this.$el.find('p.user-custom-message').text(msg).attr('title', msg);
                }
                return this;
            },

            close: function (ev) {
                if (ev && ev.preventDefault) { ev.preventDefault(); }
                if (converse.connection.connected) {
                    this.model.destroy();
                    this.setChatState(INACTIVE);
                } else {
                    this.hide();
                }
                converse.emit('chatBoxClosed', this);
                return this;
            },

            onShow: function () {
                converse.chatboxviews.trimChats(this);
                utils.refreshWebkit();
                this.$content.scrollTop(this.model.get('scroll'));
                this.setChatState(ACTIVE).focus();
                converse.emit('chatBoxMaximized', this);
            },

            maximize: function () {
                // Restore a minimized chat box
                $('#conversejs').prepend(this.$el);
                this.$el.show('fast', this.onShow.bind(this)); 
                return this;
            },

            minimize: function (ev) {
                if (ev && ev.preventDefault) { ev.preventDefault(); }
                // save the scroll position to restore it on maximize
                this.model.save({'scroll': this.$content.scrollTop()});
                // Minimizes a chat box
                this.setChatState(INACTIVE).model.minimize();
                this.$el.hide('fast', utils.refreshwebkit);
                converse.emit('chatBoxMinimized', this);
            },

            updateVCard: function () {
                if (!this.use_vcards) { return this; }
                var jid = this.model.get('jid'),
                    contact = converse.roster.get(jid);
                if ((contact) && (!contact.get('vcard_updated'))) {
                    converse.getVCard(
                        jid,
                        function (iq, jid, fullname, image, image_type, url) {
                            this.model.save({
                                'fullname' : fullname || jid,
                                'url': url,
                                'image_type': image_type,
                                'image': image
                            });
                        }.bind(this),
                        function () {
                            converse.log("ChatBoxView.initialize: An error occured while fetching vcard");
                        }
                    );
                }
                return this;
            },

            renderToolbar: function (options) {
                if (!converse.show_toolbar) {
                    return;
                }
                options = _.extend(options || {}, {
                    label_clear: __('Clear all messages'),
                    label_hide_occupants: __('Hide the list of occupants'),
                    label_insert_smiley: __('Insert a smiley'),
                    label_start_call: __('Start a call'),
                    show_call_button: converse.visible_toolbar_buttons.call,
                    show_clear_button: converse.visible_toolbar_buttons.clear,
                    show_emoticons: converse.visible_toolbar_buttons.emoticons,
                    // FIXME Leaky abstraction MUC
                    show_occupants_toggle: this.is_chatroom && converse.visible_toolbar_buttons.toggle_occupants
                });
                this.$el.find('.chat-toolbar').html(converse.templates.toolbar(_.extend(this.model.toJSON(), options || {})));
                return this;
            },

            renderAvatar: function () {
                if (!this.model.get('image')) {
                    return;
                }
                var img_src = 'data:'+this.model.get('image_type')+';base64,'+this.model.get('image'),
                    canvas = $('<canvas height="32px" width="32px" class="avatar"></canvas>').get(0);

                if (!(canvas.getContext && canvas.getContext('2d'))) {
                    return this;
                }
                var ctx = canvas.getContext('2d');
                var img = new Image();   // Create new Image object
                img.onload = function () {
                    var ratio = img.width/img.height;
                    if (ratio < 1) {
                        ctx.drawImage(img, 0,0, 32, 32*(1/ratio));
                    } else {
                        ctx.drawImage(img, 0,0, 32, 32*ratio);
                    }

                };
                img.src = img_src;
                this.$el.find('.chat-title').before(canvas);
                return this;
            },

            focus: function () {
                this.$el.find('.chat-textarea').focus();
                converse.emit('chatBoxFocused', this);
                return this;
            },

            hide: function () {
                if (this.$el.is(':visible') && this.$el.css('opacity') === "1") {
                    this.$el.hide();
                    utils.refreshWebkit();
                }
                return this;
            },

            show: _.debounce(function (focus) {
                if (this.$el.is(':visible') && this.$el.css('opacity') === "1") {
                    if (focus) { this.focus(); }
                    return this;
                }
                this.initDragResize().setDimensions();
                this.$el.fadeIn(function () {
                    if (converse.connection.connected) {
                        // Without a connection, we haven't yet initialized
                        // localstorage
                        this.model.save();
                    }
                    this.setChatState(ACTIVE);
                    this.scrollDown();
                    if (focus) {
                        this.focus();
                    }
                }.bind(this));
                return this;
            }, 250, true),

            scrollDownMessageHeight: function ($message) {
                if (this.$content.is(':visible')) {
                    this.$content.scrollTop(this.$content.scrollTop() + $message[0].scrollHeight);
                }
                return this;
            },

            scrollDown: function () {
                if (this.$content.is(':visible')) {
                    this.$content.scrollTop(this.$content[0].scrollHeight);
                }
                return this;
            }
        });

        this.ChatBoxes = Backbone.Collection.extend({
            model: converse.ChatBox,
            comparator: 'time_opened',

            registerMessageHandler: function () {
                converse.connection.addHandler(
                    function (message) {
                        this.onMessage(message);
                        return true;
                    }.bind(this), null, 'message', 'chat');
            },

            onChatBoxFetched: function (collection, resp) {
                /* Show chat boxes upon receiving them from sessionStorage
                 *
                 * This method gets overridden entirely in src/converse-controlbox.js
                 * if the controlbox plugin is active.
                 */
                collection.each(function (chatbox) {
                    if (!chatbox.get('minimized')) {
                        chatbox.trigger('show');
                    }
                });
            },

            onConnected: function () {
                this.browserStorage = new Backbone.BrowserStorage[converse.storage](
                    b64_sha1('converse.chatboxes-'+converse.bare_jid));
                this.registerMessageHandler();
                this.fetch({
                    add: true,
                    success: this.onChatBoxFetched.bind(this)
                });
            },

            onMessage: function (message) {
                /* Handler method for all incoming single-user chat "message" stanzas.
                 */
                var $message = $(message),
                    contact_jid, $forwarded, $delay, from_bare_jid, from_resource, is_me, msgid,
                    chatbox, resource,
                    from_jid = $message.attr('from'),
                    to_jid = $message.attr('to'),
                    to_resource = Strophe.getResourceFromJid(to_jid),
                    archive_id = $message.find('result[xmlns="'+Strophe.NS.MAM+'"]').attr('id');

                if (to_resource && to_resource !== converse.resource) {
                    converse.log('Ignore incoming message intended for a different resource: '+to_jid, 'info');
                    return true;
                }
                if (from_jid === converse.connection.jid) {
                    // FIXME: Forwarded messages should be sent to specific resources, not broadcasted
                    converse.log("Ignore incoming message sent from this client's JID: "+from_jid, 'info');
                    return true;
                }
                $forwarded = $message.find('forwarded');
                if ($forwarded.length) {
                    $message = $forwarded.children('message');
                    $delay = $forwarded.children('delay');
                    from_jid = $message.attr('from');
                    to_jid = $message.attr('to');
                }
                from_bare_jid = Strophe.getBareJidFromJid(from_jid);
                from_resource = Strophe.getResourceFromJid(from_jid);
                is_me = from_bare_jid === converse.bare_jid;
                msgid = $message.attr('id');

                if (is_me) {
                    // I am the sender, so this must be a forwarded message...
                    contact_jid = Strophe.getBareJidFromJid(to_jid);
                    resource = Strophe.getResourceFromJid(to_jid);
                } else {
                    contact_jid = from_bare_jid;
                    resource = from_resource;
                }
                // Get chat box, but only create a new one when the message has a body.
                chatbox = this.getChatBox(contact_jid, $message.find('body').length > 0);
                if (!chatbox) {
                    return true;
                }
                if (msgid && chatbox.messages.findWhere({msgid: msgid})) {
                    return true; // We already have this message stored.
                }
                if (chatbox.shouldPlayNotification($message)) {
                    converse.playNotification();
                }
                chatbox.createMessage($message, $delay, archive_id);
                converse.roster.addResource(contact_jid, resource);
                converse.emit('message', message);
                return true;
            },

            getChatBox: function (jid, create) {
                /* Returns a chat box or optionally return a newly
                 * created one if one doesn't exist.
                 *
                 * Parameters:
                 *    (String) jid - The JID of the user whose chat box we want
                 *    (Boolean) create - Should a new chat box be created if none exists?
                 */
                jid = jid.toLowerCase();
                var bare_jid = Strophe.getBareJidFromJid(jid);
                var chatbox = this.get(bare_jid);
                if (!chatbox && create) {
                    var roster_item = converse.roster.get(bare_jid);
                    if (roster_item === undefined) {
                        converse.log('Could not get roster item for JID '+bare_jid, 'error');
                        return;
                    }
                    chatbox = this.create({
                        'id': bare_jid,
                        'jid': bare_jid,
                        'fullname': _.isEmpty(roster_item.get('fullname'))? jid: roster_item.get('fullname'),
                        'image_type': roster_item.get('image_type'),
                        'image': roster_item.get('image'),
                        'url': roster_item.get('url')
                    });
                }
                return chatbox;
            }
        });

        this.ChatBoxViews = Backbone.Overview.extend({

            initialize: function () {
                this.model.on("add", this.onChatBoxAdded, this);
                this.model.on("change:minimized", function (item) {
                    if (item.get('minimized') === true) {
                        /* When a chat is minimized in trimChats, trimChats needs to be
                        * called again (in case the minimized chats toggle is newly shown).
                        */
                        this.trimChats();
                    } else {
                        this.trimChats(this.get(item.get('id')));
                    }
                }, this);
            },

            _ensureElement: function () {
                /* Override method from backbone.js
                 * If the #conversejs element doesn't exist, create it.
                 */
                if (!this.el) {
                    var $el = $('#conversejs');
                    if (!$el.length) {
                        $el = $('<div id="conversejs">');
                        $('body').append($el);
                    }
                    $el.html(converse.templates.chats_panel());
                    this.setElement($el, false);
                } else {
                    this.setElement(_.result(this, 'el'), false);
                }
            },

            onChatBoxAdded: function (item) {
                var view = this.get(item.get('id'));
                if (!view) {
                    view = new converse.ChatBoxView({model: item});
                    this.add(item.get('id'), view);
                } else {
                    delete view.model; // Remove ref to old model to help garbage collection
                    view.model = item;
                    view.initialize();
                }
                this.trimChats(view);
            },

            getChatBoxWidth: function (view) {
                if (!view.model.get('minimized') && view.$el.is(':visible')) {
                    return view.$el.outerWidth(true);
                }
                return 0;
            },

            trimChats: function (newchat) {
                /* This method is called when a newly created chat box will
                 * be shown.
                 *
                 * It checks whether there is enough space on the page to show
                 * another chat box. Otherwise it minimize the oldest chat box
                 * to create space.
                 */
                if (converse.no_trimming || (this.model.length <= 1)) {
                    return;
                }
                var oldest_chat,
                    $minimized = converse.minimized_chats.$el,
                    minimized_width = _.contains(this.model.pluck('minimized'), true) ? $minimized.outerWidth(true) : 0,
                    boxes_width = newchat ? newchat.$el.outerWidth(true) : 0,
                    new_id = newchat ? newchat.model.get('id') : null;

                boxes_width += _.reduce(this.xget(new_id), this.getChatBoxWidth.bind(this));

                if ((minimized_width + boxes_width) > $('body').outerWidth(true)) {
                    oldest_chat = this.getOldestMaximizedChat([new_id]);
                    if (oldest_chat) {
                        oldest_chat.minimize();
                    }
                }
            },

            getOldestMaximizedChat: function (exclude_ids) {
                // Get oldest view (if its id is not excluded)
                var i = 0;
                var model = this.model.sort().at(i);
                while (_.contains(exclude_ids, model.get('id')) ||
                       model.get('minimized') === true) {
                    i++;
                    model = this.model.at(i);
                    if (!model) {
                        return null;
                    }
                }
                return model;
            },

            closeAllChatBoxes: function () {
                /* This method gets overridden in src/converse-controlbox.js if
                 * the controlbox plugin is active.
                 */
                this.each(function (view) { view.close(); });
                return this;
            },

            showChat: function (attrs) {
                /* Find the chat box and show it. If it doesn't exist, create it.
                 */
                var chatbox  = this.model.get(attrs.jid);
                if (!chatbox) {
                    chatbox = this.model.create(attrs, {
                        'error': function (model, response) {
                            converse.log(response.responseText);
                        }
                    });
                }
                if (chatbox.get('minimized')) {
                    chatbox.maximize();
                } else {
                    chatbox.trigger('show', true);
                }
                return chatbox;
            }
        });

        this.MinimizedChatBoxView = Backbone.View.extend({
            tagName: 'div',
            className: 'chat-head',
            events: {
                'click .close-chatbox-button': 'close',
                'click .restore-chat': 'restore'
            },

            initialize: function () {
                this.model.messages.on('add', function (m) {
                    if (m.get('message')) {
                        this.updateUnreadMessagesCounter();
                    }
                }, this);
                this.model.on('change:minimized', this.clearUnreadMessagesCounter, this);
            },

            render: function () {
                var data = _.extend(
                    this.model.toJSON(),
                    { 'tooltip': __('Click to restore this chat') }
                );
                if (this.model.get('chatroom')) {
                    data.title = this.model.get('name');
                    this.$el.addClass('chat-head-chatroom');
                } else {
                    data.title = this.model.get('fullname');
                    this.$el.addClass('chat-head-chatbox');
                }
                return this.$el.html(converse.templates.trimmed_chat(data));
            },

            clearUnreadMessagesCounter: function () {
                this.model.set({'num_unread': 0});
                this.render();
            },

            updateUnreadMessagesCounter: function () {
                this.model.set({'num_unread': this.model.get('num_unread') + 1});
                this.render();
            },

            close: function (ev) {
                if (ev && ev.preventDefault) { ev.preventDefault(); }
                this.remove();
                this.model.destroy();
                converse.emit('chatBoxClosed', this);
                return this;
            },

            restore: _.debounce(function (ev) {
                if (ev && ev.preventDefault) { ev.preventDefault(); }
                this.model.messages.off('add',null,this);
                this.remove();
                this.model.maximize();
            }, 200, true)
        });

        this.MinimizedChats = Backbone.Overview.extend({
            el: "#minimized-chats",
            events: {
                "click #toggle-minimized-chats": "toggle"
            },

            initialize: function () {
                this.initToggle();
                this.model.on("add", this.onChanged, this);
                this.model.on("destroy", this.removeChat, this);
                this.model.on("change:minimized", this.onChanged, this);
                this.model.on('change:num_unread', this.updateUnreadMessagesCounter, this);
            },

            tearDown: function () {
                this.model.off("add", this.onChanged);
                this.model.off("destroy", this.removeChat);
                this.model.off("change:minimized", this.onChanged);
                this.model.off('change:num_unread', this.updateUnreadMessagesCounter);
                return this;
            },

            initToggle: function () {
                this.toggleview = new converse.MinimizedChatsToggleView({
                    model: new converse.MinimizedChatsToggle()
                });
                var id = b64_sha1('converse.minchatstoggle'+converse.bare_jid);
                this.toggleview.model.id = id; // Appears to be necessary for backbone.browserStorage
                this.toggleview.model.browserStorage = new Backbone.BrowserStorage[converse.storage](id);
                this.toggleview.model.fetch();
            },

            render: function () {
                if (this.keys().length === 0) {
                    this.$el.hide('fast');
                } else if (this.keys().length === 1) {
                    this.$el.show('fast');
                }
                return this.$el;
            },

            toggle: function (ev) {
                if (ev && ev.preventDefault) { ev.preventDefault(); }
                this.toggleview.model.save({'collapsed': !this.toggleview.model.get('collapsed')});
                this.$('.minimized-chats-flyout').toggle();
            },

            onChanged: function (item) {
                if (item.get('minimized')) {
                    this.addChat(item);
                } else if (this.get(item.get('id'))) {
                    this.removeChat(item);
                }
            },

            addChat: function (item) {
                var existing = this.get(item.get('id'));
                if (existing && existing.$el.parent().length !== 0) {
                    return;
                }
                var view = new converse.MinimizedChatBoxView({model: item});
                this.$('.minimized-chats-flyout').append(view.render());
                this.add(item.get('id'), view);
                this.toggleview.model.set({'num_minimized': this.keys().length});
                this.render();
            },

            removeChat: function (item) {
                this.remove(item.get('id'));
                this.toggleview.model.set({'num_minimized': this.keys().length});
                this.render();
            },

            updateUnreadMessagesCounter: function () {
                var ls = this.model.pluck('num_unread'),
                    count = 0, i;
                for (i=0; i<ls.length; i++) { count += ls[i]; }
                this.toggleview.model.set({'num_unread': count});
                this.render();
            }
        });

        this.MinimizedChatsToggle = Backbone.Model.extend({
            initialize: function () {
                this.set({
                    'collapsed': this.get('collapsed') || false,
                    'num_minimized': this.get('num_minimized') || 0,
                    'num_unread':  this.get('num_unread') || 0
                });
            }
        });

        this.MinimizedChatsToggleView = Backbone.View.extend({
            el: '#toggle-minimized-chats',

            initialize: function () {
                this.model.on('change:num_minimized', this.render, this);
                this.model.on('change:num_unread', this.render, this);
                this.$flyout = this.$el.siblings('.minimized-chats-flyout');
            },

            render: function () {
                this.$el.html(converse.templates.toggle_chats(
                    _.extend(this.model.toJSON(), {
                        'Minimized': __('Minimized')
                    })
                ));
                if (this.model.get('collapsed')) {
                    this.$flyout.hide();
                } else {
                    this.$flyout.show();
                }
                return this.$el;
            }
        });

        this.XMPPStatus = Backbone.Model.extend({
            initialize: function () {
                this.set({
                    'status' : this.getStatus()
                });
                this.on('change', function (item) {
                    if (this.get('fullname') === undefined) {
                        converse.getVCard(
                            null, // No 'to' attr when getting one's own vCard
                            function (iq, jid, fullname, image, image_type, url) {
                                this.save({'fullname': fullname});
                            }.bind(this)
                        );
                    }
                    if (_.has(item.changed, 'status')) {
                        converse.emit('statusChanged', this.get('status'));
                    }
                    if (_.has(item.changed, 'status_message')) {
                        converse.emit('statusMessageChanged', this.get('status_message'));
                    }
                }.bind(this));
            },

            constructPresence: function (type, status_message) {
                if (typeof type === 'undefined') {
                    type = this.get('status') || 'online';
                }
                if (typeof status_message === 'undefined') {
                    status_message = this.get('status_message');
                }
                var presence;
                // Most of these presence types are actually not explicitly sent,
                // but I add all of them here fore reference and future proofing.
                if ((type === 'unavailable') ||
                        (type === 'probe') ||
                        (type === 'error') ||
                        (type === 'unsubscribe') ||
                        (type === 'unsubscribed') ||
                        (type === 'subscribe') ||
                        (type === 'subscribed')) {
                    presence = $pres({'type': type});
                } else if (type === 'offline') {
                    presence = $pres({'type': 'unavailable'});
                    if (status_message) {
                        presence.c('show').t(type);
                    }
                } else {
                    if (type === 'online') {
                        presence = $pres();
                    } else {
                        presence = $pres().c('show').t(type).up();
                    }
                    if (status_message) {
                        presence.c('status').t(status_message);
                    }
                }
                return presence;
            },

            sendPresence: function (type, status_message) {
                converse.connection.send(this.constructPresence(type, status_message));
            },

            setStatus: function (value) {
                this.sendPresence(value);
                this.save({'status': value});
            },

            getStatus: function () {
                return this.get('status') || 'online';
            },

            setStatusMessage: function (status_message) {
                this.sendPresence(this.getStatus(), status_message);
                var prev_status = this.get('status_message');
                this.save({'status_message': status_message});
                if (this.xhr_custom_status) {
                    $.ajax({
                        url:  this.xhr_custom_status_url,
                        type: 'POST',
                        data: {'msg': status_message}
                    });
                }
                if (prev_status === status_message) {
                    this.trigger("update-status-ui", this);
                }
            }
        });

        this.Session = Backbone.Model; // General session settings to be saved to sessionStorage.
        this.Feature = Backbone.Model;
        this.Features = Backbone.Collection.extend({
            /* Service Discovery
            * -----------------
            * This collection stores Feature Models, representing features
            * provided by available XMPP entities (e.g. servers)
            * See XEP-0030 for more details: http://xmpp.org/extensions/xep-0030.html
            * All features are shown here: http://xmpp.org/registrar/disco-features.html
            */
            model: converse.Feature,
            initialize: function () {
                this.addClientIdentities().addClientFeatures();
                this.browserStorage = new Backbone.BrowserStorage[converse.storage](
                    b64_sha1('converse.features'+converse.bare_jid));
                this.on('add', this.onFeatureAdded, this);
                if (this.browserStorage.records.length === 0) {
                    // browserStorage is empty, so we've likely never queried this
                    // domain for features yet
                    converse.connection.disco.info(converse.domain, null, this.onInfo.bind(this));
                    converse.connection.disco.items(converse.domain, null, this.onItems.bind(this));
                } else {
                    this.fetch({add:true});
                }
            },

            onFeatureAdded: function (feature) {
                var prefs = feature.get('preferences') || {};
                converse.emit('serviceDiscovered', feature);
                if (feature.get('var') === Strophe.NS.MAM && prefs['default'] !== converse.message_archiving) {
                    // Ask the server for archiving preferences
                    converse.connection.sendIQ(
                        $iq({'type': 'get'}).c('prefs', {'xmlns': Strophe.NS.MAM}),
                        _.bind(this.onMAMPreferences, this, feature),
                        _.bind(this.onMAMError, this, feature)
                    );
                }
            },

            onMAMPreferences: function (feature, iq) {
                /* Handle returned IQ stanza containing Message Archive
                 * Management (XEP-0313) preferences.
                 *
                 * XXX: For now we only handle the global default preference.
                 * The XEP also provides for per-JID preferences, which is
                 * currently not supported in converse.js.
                 *
                 * Per JID preferences will be set in chat boxes, so it'll
                 * probbaly be handled elsewhere in any case.
                 */
                var $prefs = $(iq).find('prefs[xmlns="'+Strophe.NS.MAM+'"]');
                var default_pref = $prefs.attr('default');
                var stanza;
                if (default_pref !== converse.message_archiving) {
                    stanza = $iq({'type': 'set'}).c('prefs', {'xmlns':Strophe.NS.MAM, 'default':converse.message_archiving});
                    $prefs.children().each(function (idx, child) {
                        stanza.cnode(child).up();
                    });
                    converse.connection.sendIQ(stanza, _.bind(function (feature, iq) {
                            // XXX: Strictly speaking, the server should respond with the updated prefs
                            // (see example 18: https://xmpp.org/extensions/xep-0313.html#config)
                            // but Prosody doesn't do this, so we don't rely on it.
                            feature.save({'preferences': {'default':converse.message_archiving}});
                        }, this, feature),
                        _.bind(this.onMAMError, this, feature)
                    );
                } else {
                    feature.save({'preferences': {'default':converse.message_archiving}});
                }
            },

            onMAMError: function (iq) {
                if ($(iq).find('feature-not-implemented').length) {
                    converse.log("Message Archive Management (XEP-0313) not supported by this browser");
                } else {
                    converse.log("An error occured while trying to set archiving preferences.");
                    converse.log(iq);
                }
            },

            addClientIdentities: function () {
                /* See http://xmpp.org/registrar/disco-categories.html
                 */
                 converse.connection.disco.addIdentity('client', 'web', 'Converse.js');
                 return this;
            },

            addClientFeatures: function () {
                /* The strophe.disco.js plugin keeps a list of features which
                 * it will advertise to any #info queries made to it.
                 *
                 * See: http://xmpp.org/extensions/xep-0030.html#info
                 */
                converse.connection.disco.addFeature('jabber:x:conference');
                converse.connection.disco.addFeature(Strophe.NS.BOSH);
                converse.connection.disco.addFeature(Strophe.NS.CHATSTATES);
                converse.connection.disco.addFeature(Strophe.NS.DISCO_INFO);
                converse.connection.disco.addFeature(Strophe.NS.MAM);
                converse.connection.disco.addFeature(Strophe.NS.ROSTERX); // Limited support
                if (converse.use_vcards) {
                    converse.connection.disco.addFeature(Strophe.NS.VCARD);
                }
                if (converse.message_carbons) {
                    converse.connection.disco.addFeature(Strophe.NS.CARBONS);
                }
                return this;
            },

            onItems: function (stanza) {
                $(stanza).find('query item').each(function (idx, item) {
                    converse.connection.disco.info(
                        $(item).attr('jid'),
                        null,
                        this.onInfo.bind(this));
                }.bind(this));
            },

            onInfo: function (stanza) {
                var $stanza = $(stanza);
                if (($stanza.find('identity[category=server][type=im]').length === 0) &&
                    ($stanza.find('identity[category=conference][type=text]').length === 0)) {
                    // This isn't an IM server component
                    return;
                }
                $stanza.find('feature').each(function (idx, feature) {
                    var namespace = $(feature).attr('var');
                    this[namespace] = true;
                    this.create({
                        'var': namespace,
                        'from': $stanza.attr('from')
                    });
                }.bind(this));
            }
        });

        this.setUpXMLLogging = function () {
            if (this.debug) {
                this.connection.xmlInput = function (body) { converse.log(body); };
                this.connection.xmlOutput = function (body) { converse.log(body); };
            }
        };

        this.startNewBOSHSession = function () {
            $.ajax({
                url:  this.prebind_url,
                type: 'GET',
                success: function (response) {
                    this.connection.attach(
                            response.jid,
                            response.sid,
                            response.rid,
                            this.onConnectStatusChanged
                    );
                }.bind(this),
                error: function (response) {
                    delete this.connection;
                    this.emit('noResumeableSession');
                }.bind(this)
            });
        };

        this.attemptPreboundSession = function (tokens) {
            /* Handle session resumption or initialization when prebind is being used.
             */
            if (this.keepalive) {
                if (!this.jid) {
                    throw new Error("initConnection: when using 'keepalive' with 'prebind, you must supply the JID of the current user.");
                }
                try {
                    return this.connection.restore(this.jid, this.onConnectStatusChanged);
                } catch (e) {
                    this.log("Could not restore session for jid: "+this.jid+" Error message: "+e.message);
                    this.clearSession(); // If there's a roster, we want to clear it (see #555)
                }
            } else { // Not keepalive
                if (this.jid && this.sid && this.rid) {
                    return this.connection.attach(this.jid, this.sid, this.rid, this.onConnectStatusChanged);
                } else {
                    throw new Error("initConnection: If you use prebind and not keepalive, "+
                        "then you MUST supply JID, RID and SID values");
                }
            }
            // We haven't been able to attach yet. Let's see if there
            // is a prebind_url, otherwise there's nothing with which
            // we can attach.
            if (this.prebind_url) {
                this.startNewBOSHSession();
            } else {
                delete this.connection;
                this.emit('noResumeableSession');
            }
        };

        this.attemptNonPreboundSession = function () {
            /* Handle session resumption or initialization when prebind is not being used.
             *
             * Two potential options exist and are handled in this method:
             *  1. keepalive
             *  2. auto_login
             */
            if (this.keepalive) {
                try {
                    return this.connection.restore(undefined, this.onConnectStatusChanged);
                } catch (e) {
                    this.log("Could not restore session. Error message: "+e.message);
                    this.clearSession(); // If there's a roster, we want to clear it (see #555)
                }
            }
            if (this.auto_login) {
                if (!this.jid) {
                    throw new Error("initConnection: If you use auto_login, you also need to provide a jid value");
                }
                if (this.authentication === converse.ANONYMOUS) {
                    this.connection.connect(this.jid.toLowerCase(), null, this.onConnectStatusChanged);
                } else if (this.authentication === converse.LOGIN) {
                    if (!this.password) {
                        throw new Error("initConnection: If you use auto_login and "+
                            "authentication='login' then you also need to provide a password.");
                    }
                    var resource = Strophe.getResourceFromJid(this.jid);
                    if (!resource) {
                        this.jid = this.jid.toLowerCase() + converse.generateResource();
                    } else {
                        this.jid = Strophe.getBareJidFromJid(this.jid).toLowerCase()+'/'+resource;
                    }
                    this.connection.connect(this.jid, this.password, this.onConnectStatusChanged);
                }
            }
        };

        this.initConnection = function () {
            if (this.connection && this.connection.connected) {
                this.setUpXMLLogging();
                this.onConnected();
            } else {
                if (!this.bosh_service_url && ! this.websocket_url) {
                    throw new Error("initConnection: you must supply a value for either the bosh_service_url or websocket_url or both.");
                }
                if (('WebSocket' in window || 'MozWebSocket' in window) && this.websocket_url) {
                    this.connection = new Strophe.Connection(this.websocket_url);
                } else if (this.bosh_service_url) {
                    this.connection = new Strophe.Connection(this.bosh_service_url, {'keepalive': this.keepalive});
                } else {
                    throw new Error("initConnection: this browser does not support websockets and bosh_service_url wasn't specified.");
                }
                this.setUpXMLLogging();
                // We now try to resume or automatically set up a new session.
                // Otherwise the user will be shown a login form.
                if (this.authentication === converse.PREBIND) {
                    this.attemptPreboundSession();
                } else {
                    this.attemptNonPreboundSession();
                }
            }
        };

        this._tearDown = function () {
            /* Remove those views which are only allowed with a valid
             * connection.
             */
            if (this.roster) {
                this.roster.off().reset(); // Removes roster contacts
            }
            if (this.rosterview) {
                this.rosterview.unregisterHandlers();
                this.rosterview.model.off().reset(); // Removes roster groups
                this.rosterview.undelegateEvents().remove();
            }
            this.chatboxes.remove(); // Don't call off(), events won't get re-registered upon reconnect.
            if (this.features) {
                this.features.reset();
            }
            if (this.minimized_chats) {
                this.minimized_chats.undelegateEvents().model.reset();
                this.minimized_chats.removeAll(); // Remove sub-views
                this.minimized_chats.tearDown().remove(); // Remove overview
                delete this.minimized_chats;
            }
            return this;
        };

        this._initialize = function () {
            this.chatboxes = new this.ChatBoxes();
            this.chatboxviews = new this.ChatBoxViews({model: this.chatboxes});
            this.initSession();
            this.initConnection();
            return this;
        };

        this.wrappedOverride = function (key, value, super_method, clean) {
            // We create a partially applied wrapper function, that
            // makes sure to set the proper super method when the
            // overriding method is called. This is done to enable
            // chaining of plugin methods, all the way up to the
            // original method.
            var ret;
            if (clean) {
                converse._super = { 'converse': converse };
            }
            this._super[key] = super_method;
            ret = value.apply(this, _.rest(arguments, 4));
            if (clean) { delete this._super; }
            return ret;
        };

        this._overrideAttribute = function (key, plugin) {
            // See converse.plugins.override
            var value = plugin.overrides[key];
            if (typeof value === "function") {
                var wrapped_function = _.partial(
                    converse.wrappedOverride.bind(converse),
                    key, value, converse[key].bind(converse), true
                );
                converse[key] = wrapped_function;
            } else {
                converse[key] = value;
            }
        };

        this._extendObject = function (obj, attributes) {
            // See converse.plugins.extend
            if (!obj.prototype._super) {
                obj.prototype._super = {'converse': converse};
            }
            _.each(attributes, function (value, key) {
                if (key === 'events') {
                    obj.prototype[key] = _.extend(value, obj.prototype[key]);
                } else if (typeof value === 'function') {
                    // We create a partially applied wrapper function, that
                    // makes sure to set the proper super method when the
                    // overriding method is called. This is done to enable
                    // chaining of plugin methods, all the way up to the
                    // original method.
                    var wrapped_function = _.partial(
                        converse.wrappedOverride,
                        key, value, obj.prototype[key], false
                    );
                    obj.prototype[key] = wrapped_function;
                } else {
                    obj.prototype[key] = value;
                }
            });
        };

        this.initializePlugins = function () {
            _.each(_.keys(this.plugins), function (name) {
                var plugin = this.plugins[name];
                if (_.contains(this.initialized_plugins, name)) {
                    // Don't initialize plugins twice, otherwise we get
                    // infinite recursion in overridden methods.
                    return;
                }
                plugin.converse = converse;
                _.each(Object.keys(plugin.overrides), function (key) {
                    /* We automatically override all methods and Backbone views and
                     * models that are in the "overrides" namespace.
                     */
                    var override = plugin.overrides[key];
                    if (typeof override === "object") {
                        this._extendObject(converse[key], override);
                    } else {
                        this._overrideAttribute(key, plugin);
                    }
                }.bind(this));

                if (typeof plugin.initialize === "function") {
                    plugin.initialize.bind(plugin)(this);
                }
                this.initialized_plugins.push(name);
            }.bind(this));
        };

        // Initialization
        // --------------
        // This is the end of the initialize method.
        if (settings.connection) {
            this.connection = settings.connection;
        }
        this.initializePlugins();
        this._initialize();
        this.registerGlobalEventHandlers();
        converse.emit('initialized');
    };
    return converse;
}));
