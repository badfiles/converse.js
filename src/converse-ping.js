// Converse.js (A browser based XMPP chat client)
// http://conversejs.org
//
// Copyright (c) 2012-2016, Jan-Carel Brand <jc@opkode.com>
// Licensed under the Mozilla Public License (MPLv2)
//
/*global define */

/* This is a Converse.js plugin which add support for application-level pings
 * as specified in XEP-0199 XMPP Ping.
 */
(function (root, factory) {
    define("converse-ping", [
        "converse-core",
        "converse-api",
        "strophe.ping"
    ], factory);
}(this, function (converse, converse_api) {
    "use strict";
    // Strophe methods for building stanzas
    var Strophe = converse_api.env.Strophe;
    // Other necessary globals
    var _ = converse_api.env._;
    
    converse_api.plugins.add('ping', {

        overrides: {
            // Overrides mentioned here will be picked up by converse.js's
            // plugin architecture they will replace existing methods on the
            // relevant objects or classes.
            //
            // New functions which don't exist yet can also be added.

            onConnected: function () {
                this._super.onConnected().done(this.registerPingHandler);
            },
            onReconnected: function () {
                // We need to re-register the ping event handler on the newly
                // created connection.
                this._super.onReconnected().done(this.registerPingHandler);
            }
        },

        initialize: function () {
            /* The initialize function gets called as soon as the plugin is
             * loaded by converse.js's plugin machinery.
             */
            var converse = this.converse;
            // Configuration values for this plugin
            var settings = {
                ping_interval: 180 //in seconds
            };
            _.extend(converse, settings);
            _.extend(converse, _.pick(converse.user_settings, Object.keys(settings)));

            converse.ping = function (jid, success, error, timeout) {
                // XXX: We could first check here if the server advertised that
                // it supports PING.
                // However, some servers don't advertise while still keeping the
                // connection option due to pings.
                //
                // var feature = converse.features.findWhere({'var': Strophe.NS.PING});
                converse.lastStanzaDate = new Date();
                if (typeof jid === 'undefined' || jid === null) {
                    jid = Strophe.getDomainFromJid(converse.bare_jid);
                }
                if (typeof timeout === 'undefined' ) { timeout = null; }
                if (typeof success === 'undefined' ) { success = null; }
                if (typeof error === 'undefined' ) { error = null; }
                if (converse.connection) {
                    converse.connection.ping.ping(jid, success, error, timeout);
                    return true;
                }
                return false;
            };

            converse.pong = function (ping) {
                converse.lastStanzaDate = new Date();
                converse.connection.ping.pong(ping);
                return true;
            };

            converse.registerPongHandler = function () {
                converse.connection.disco.addFeature(Strophe.NS.PING);
                converse.connection.ping.addPingHandler(this.pong);
            };

            converse.registerPingHandler = function () {
                converse.registerPongHandler();
                if (converse.ping_interval > 0) {
                    converse.connection.addHandler(function () {
                        /* Handler on each stanza, saves the received date
                         * in order to ping only when needed.
                         */
                        converse.lastStanzaDate = new Date();
                        return true;
                    });
                    converse.connection.addTimedHandler(1000, function () {
                        var now = new Date();
                        if (!converse.lastStanzaDate) {
                            converse.lastStanzaDate = now;
                        }
                        if ((now - converse.lastStanzaDate)/1000 > this.ping_interval) {
                            return converse.ping();
                        }
                        return true;
                    });
                }
            };

            _.extend(converse_api, {
                /* We extend the default converse.js API to add a method specific
                 * to this plugin.
                 */
                'ping': function (jid) {
                    converse.ping(jid);
                }
            });
        }
    });
}));
