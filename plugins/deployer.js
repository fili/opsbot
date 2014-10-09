/*
    Perform deployments with Ansible, and robots!

    config options:
    {
        ansible: '/path/to/ansible-playbook',
        configdir: '/path/to/ansible-data',
        playbooks:
        {
            'app-name': './playbooks/app-name.yml',
            'another':  './playbooks/deploy-another.yml'
        }
    }

    For OS X testing, get stdbuf this way:
    brew tap paulp/extras
    brew install --HEAD stdbuf
*/

var
    _      = require('lodash'),
    assert = require('assert'),
    path   = require('path'),
    spawn  = require('child_process').spawn;

var PATTERNS =
{
    PLAY:  /PLAY \[(.*)\]/,
    TASK:  /TASK:\s+\[.* \|\s?(.*)\]/,
    FACTS: /GATHERING FACTS/,
};

var Deployer = module.exports = function Deployer(opts)
{
    assert(opts && _.isObject(opts), 'the deployer plugin requires an options object');
    assert(opts.configdir && _.isString(opts.configdir), 'you must pass the path to your ansible data directory in `opts.configdir`');
    assert(opts.ansible && _.isString(opts.ansible), 'you must provide the path to the ansible-playbook executable in `opts.ansible`');
    assert(opts.playbooks && _.isObject(opts.playbooks), 'you must explicitly name accessible playbooks in `opts.playbooks`');

    _.extend(this, opts);
    if (!this.spawn) this.spawn = spawn;
};

Deployer.prototype.name = 'deployer';
Deployer.prototype.pattern = /deploy\s+(\w+)\s?([\w-.]+)?$/;

Deployer.prototype.matches = function matches(msg)
{
    return this.pattern.test(msg);
};

Deployer.prototype.respond = function respond(message)
{
    var msg = message.text,
        matches = this.pattern.exec(msg);


    if (!matches || ['staging', 'production', 'development'].indexOf(matches[1]) == -1) {
        message.done(this.help());
        return;
    }

    this.execute('www', matches[1], matches[2] || 'HEAD', message);
};

Deployer.prototype.help = function help(msg)
{
    return 'Run an ansible playbook for a specific inventory\n' +
        '`deploy [script] [inventory] [branch]` - run the named script; branch is optional\n' +
        '`deploy www to production` would deploy www to prod\n' +
        '`deploy add-ssh-keys to production` would run the ssh keys role on production\n' +
        'as would `deploy add-ssh-keys production`\n' +
        '';
};

Deployer.prototype.execute = function execute(app, environment, branch, message)
{
    var playbook = this.playbooks[app];

    var ansible = this.spawn('stdbuf',
            ['-o0', this.ansible, playbook, '-i', environment, '-e', 'npm_deploy_branch=' + branch],
            { cwd: this.configdir });

    var accumulator = [];
    var error = false;
    var last;
    var interesting = /(TASK|GATHERING FACTS|PLAY \[)/;

    var tag = app + ' ➜ ' + environment;
    message.send('Deploying ' + tag);

    ansible.stdout.on('data', function(data)
    {
        var output = data.toString();
        accumulator.push(output);

        if (!interesting.test(output))
        {
            if (!last) return;
            if (/ok: /.test(output))
                message.send(tag + ': ' + last);
            if (/fatal: /.test(output))
            {
                error = true;
                message.send(tag + ' fatal error\nTask: ' + last + '\n' + output);
            }

            last = null;
            return;
        }

        var matches;

        matches = output.match(PATTERNS.PLAY);
        if (matches)
        {
            last = 'executing play ' + matches[1];
            return;
        }

        matches = output.match(PATTERNS.TASK);
        if (matches)
        {
            last = matches[1];
            return;
        }

        matches = output.match(PATTERNS.FACTS);
        if (matches)
        {
            last = 'fact-finding';
            return;
        }
    });

    ansible.stderr.on('data', function(data)
    {
        message.send(data.toString());
    });

    ansible.on('close', function(code)
    {
        setTimeout(function()
        {
            if (error)
            {
                accumulator.unshift('```');
                accumulator.push('```');
                message.send(accumulator.join(''));
            }
            message.send(tag + ': complete.');
            message.done();
        }, 500);
    });
};
