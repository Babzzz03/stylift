=== StyleLift Importer ===
Contributors: stylelift
Tags: elementor, import, templates, sections
Requires at least: 5.6
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Turn sections captured from live websites with the StyleLift browser extension into Elementor templates or pages.

== Description ==

The StyleLift browser extension captures any website section with its styles and animations. This plugin receives those sections and creates:

* an Elementor saved template (section or page type), or
* a draft page laid out in Elementor.

Images can be copied into your Media Library during the import, so the new page does not depend on the original site.

Security: imports require an account with the `unfiltered_html` capability (Administrators and Editors on single sites), the same rule WordPress applies to raw HTML in its own editors. Scripts, inline event handlers and javascript: links are removed on the server.

== Installation ==

1. Upload the `stylelift-importer` folder to `/wp-content/plugins/`, or upload the zip under Plugins → Add New → Upload.
2. Activate the plugin. Elementor is recommended; without it imports are stored and open in Elementor once it is activated.
3. Go to Tools → StyleLift Importer and follow the steps to connect the extension with an Application Password.

== Changelog ==

= 1.0.0 =
* First release: template and page import, Media Library image copying, connection check.
