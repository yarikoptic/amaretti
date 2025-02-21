#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const async = require('async');
const ss = require('simple-statistics');

const config = require('../config');
const db = require('../api/models');

db.init(function(err) {
    if(err) throw err;
    let service_info = {};
    async.series([

        //I might deprecate this counter in favor of more user specific counter below
        next=>{
            console.log("group events by service and status");
            db.Taskevent.aggregate([
                {$group: {_id: { status: "$status", service: "$service"}, count: {$sum: 1}}},
            ]).exec((err, statuses)=>{
                if(err) return next(err);
                console.log("got service state counts");
                statuses.forEach(status=>{
                    if(!service_info[status._id.service]) {
                        //init
                        service_info[status._id.service] = {
                            counts: {
                                failed: 0,
                                finished: 0,
                                removed: 0,
                                requested: 0,
                                running: 0,
                                running_sync: 0,
                                stop_requested: 0,
                                stopped: 0,
                            },

                            user: {},
                        }
                    }
                    service_info[status._id.service].counts[status._id.status] = status.count;
                    
                    //calculate success_rate
                    let finished = service_info[status._id.service].counts.finished;
                    let failed = service_info[status._id.service].counts.failed;
                    if(finished+failed > 0) service_info[status._id.service].success_rate = (finished / (failed+finished))*100;
                });
                next();
            });
        },

        //TODO - users and user seems to be redundant.. can we drop either?
        async next=>{
            console.log("group events by service/user/status");

            let finished = await db.Taskevent.aggregate([
                {$match: { status: "finished" }},
                {$group: {_id: { user: "$user_id", service: "$service"}, count: {$sum: 1}}},
            ]);
            finished.forEach(status=>{
                //if(!service_info[status._id.service]) service_info[status._id.service] = {users: {}};
                if(!service_info[status._id.service].user[status._id.user]) service_info[status._id.service].user[status._id.user] = {};
                service_info[status._id.service].user[status._id.user].finished = status.count;
            });

            let failed = await db.Taskevent.aggregate([
                {$match: { status: "failed" }},
                {$group: {_id: { user: "$user_id", service: "$service"}, count: {$sum: 1}}},
            ]);
            failed.forEach(status=>{
                if(!service_info[status._id.service].user[status._id.user]) service_info[status._id.service].user[status._id.user] = {};
                service_info[status._id.service].user[status._id.user].failed = status.count;
            });

        },

        //TODO - users and user seems to be redundant.. can we drop either?
        next=>{
            console.log("group by service and user count");
            db.Taskevent.aggregate([
                {$match: { status: "requested" }},
                //first aggregate by service/user
                {$group: {_id: {service: "$service", user: "$user_id"}, users: {$sum: 1}}}, 
                //then count users to get distinct user
                {$group: {_id: {service: "$_id.service"}, distinct: {$sum: 1}}}, 
            ]).exec((err, users)=>{
                if(err) return next(err);
                //console.log("got user count"); 
                //console.log(JSON.stringify(users, null, 4));
                users.forEach(user=>{
                    if(user._id.service == null) return; //TODO why does this happen?
                    service_info[user._id.service].users = user.distinct;
                });
                next();
            });
        },

        next=>{
            console.log("group by service and _group_id");
            db.Taskevent.aggregate([
                {$match: { status: "requested" }},
                //first aggregate by service/group
                {$group: {_id: {service: "$service", groupId: "$_group_id"}, groups: {$sum: 1}}},
                //then count to get distinct user
                {$group: {_id: {service: "$_id.service"}, distinct: {$sum: 1}}}, 
            ]).exec((err, groups)=>{
                if(err) return next(err);
                groups.forEach(group=>{
                    if(group._id.service == null) return; //TODO why does this happen?
                    service_info[group._id.service].groups = group.distinct;
                    console.log("distinct", group._id.service, group.distinct);
                });
                next();
            });
        },

        next=>{
            async.eachOfSeries(service_info, (v, k, next_service)=>{
                console.log("analying average runtime from the most recent 100 finishes for...", k);
                db.Taskevent.find({service: k, status: "finished"})
                .sort('-date').select('date task_id').limit(100).exec((err, finish_events)=>{
                    if(err) return next_service(err);
                    if(finish_events.length == 0) {
                        console.log("never finished..");
                        return next_service();
                    }

                    let runtimes = [];
                    async.eachSeries(finish_events, (finish_event, next_finish_event)=>{
                        //find when it started running for tha task
                        db.Taskevent.findOne({
                            service: k, 
                            status: {$in: ["running", "running_sync"]}, 
                            task_id: finish_event.task_id, 
                            date: {$lt: finish_event.date}
                        }).select('date').sort('-date').exec((err, start_event)=>{
                            if(err) return next_finish_event(err);
                            if(!start_event) {
                                console.log("no running/running_sync event.. odd?");
                                return next_finish_event();
                            }
                            runtimes.push(finish_event.date - start_event.date);
                            next_finish_event();
                        });
                    }, err=>{
                        if(err) return next_service(err);
                        service_info[k].runtime_mean = ss.mean(runtimes);
                        service_info[k].runtime_std = ss.standardDeviation(runtimes);
                        //console.dir(service_info[k]);
                        next_service();
                    });
                });
            }, next);
        },


    ], err=>{
        if(err) throw err;
        console.log("saving");
        async.eachOfSeries(service_info, (v, k, next_service)=>{
            let info = service_info[k]; 
            db.Serviceinfo.findOne({service: k}).exec((err, s)=>{
                if(err) throw err;
                if(!s) {
                    console.log("need to insert", k);
                    s = new db.Serviceinfo(info);
                    s.service = k;
                    s.save(next_service);
                } else {
                    console.log("updating", k);
                    for(var key in info) s[key] = info[key];
                    s.save(next_service);
                }
            });
        }, err=>{
            if(err) throw err;
            console.log("all done");
            db.disconnect();
            /*
            setTimeout(()=>{
                console.log("somehow doesn't terminate... so killing myself");
                process.exit(1);
            }, 2000);
            */
        });
    });
}, false); //don't connect to amqp


