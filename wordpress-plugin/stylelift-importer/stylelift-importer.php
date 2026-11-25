<?php
/**
 * Plugin Name:       StyleLift Importer
 * Description:       Receives sections captured from live websites by the StyleLift browser extension and turns them into Elementor templates or pages.
 * Version:           1.0.0
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Author:            StyleLift
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       stylelift-importer
 *
 * Written against Elementor's documented template format and WordPress's public APIs.
 * No Elementor code is included or required: without Elementor the import is still
 * stored, and opens in Elementor once it is activated.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'STYLELIFT_IMPORTER_VERSION', '1.0.0' );

require_once __DIR__ . '/includes/class-stylelift-sanitizer.php';
require_once __DIR__ . '/includes/class-stylelift-importer.php';
require_once __DIR__ . '/includes/class-stylelift-admin.php';

add_action( 'rest_api_init', array( 'StyleLift_Importer', 'register_routes' ) );
add_action( 'admin_menu', array( 'StyleLift_Admin', 'register_page' ) );
