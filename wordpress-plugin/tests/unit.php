<?php
// Unit checks for the plugin's pure logic (sanitizer, image URL discovery / rewriting),
// with minimal stand-ins for the few WordPress functions they call.
define( 'ABSPATH', __DIR__ . '/' );
class WP_Error { public $code; public $message; public $data; function __construct( $c = '', $m = '', $d = null ) { $this->code = $c; $this->message = $m; $this->data = $d; } }
function is_wp_error( $x ) { return $x instanceof WP_Error; }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function esc_attr( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
define( 'STYLELIFT_IMPORTER_VERSION', 'test' );
require __DIR__ . '/../stylelift-importer/includes/class-stylelift-sanitizer.php';
require __DIR__ . '/../stylelift-importer/includes/class-stylelift-importer.php';

$passed = 0; $failed = array();
function ok( $c, $label ) { global $passed, $failed; if ( $c ) { $passed++; echo "  ✓ $label\n"; } else { $failed[] = $label; echo "  ✗ $label\n"; } }

$tree = array(
	array( 'id' => 'a1b2c3d', 'elType' => 'container', 'settings' => array( 'content_width' => 'full' ), 'elements' => array(
		array( 'id' => 'w1', 'elType' => 'widget', 'widgetType' => 'html', 'settings' => array(
			'html' => '<section class="hero" onclick="steal()"><script>alert(1)</script><img src="https://cdn.example.com/a.jpg?w=800&amp;q=80" srcset="https://cdn.example.com/a@2x.jpg 2x"><a href="javascript:alert(2)">x</a><div style="background:url(\'https://cdn.example.com/bg.webp\')"></div><base href="https://evil.example/"><iframe srcdoc="<script>x</script>"></iframe></section>',
		), 'elements' => array() ),
		array( 'id' => '!!', 'elType' => 'evil', 'settings' => array(), 'elements' => array() ),
	) ),
);
$clean = StyleLift_Sanitizer::clean_elements( $tree );
$html  = $clean[0]['elements'][0]['settings']['html'];
ok( ! is_wp_error( $clean ) && count( $clean ) === 1, 'element tree accepted' );
ok( 1 === count( $clean[0]['elements'] ), 'unknown element types dropped' );
ok( false === stripos( $html, '<script' ), 'script blocks removed' );
ok( false === stripos( $html, 'onclick' ), 'inline event handlers removed' );
ok( false === stripos( $html, 'javascript:' ), 'javascript: links neutralised' );
ok( false === stripos( $html, '<base' ), '<base> removed (it would retarget every link)' );
ok( false === stripos( $html, 'srcdoc' ), 'iframe srcdoc removed' );
ok( false !== strpos( $html, 'class="hero"' ) && false !== strpos( $html, 'background:url(' ), 'layout and styles kept' );
ok( is_wp_error( StyleLift_Sanitizer::clean_elements( array() ) ), 'empty import rejected' );
$deep = array( 'elType' => 'container', 'elements' => array() ); $node = &$deep;
for ( $i = 0; $i < 60; $i++ ) { $node['elements'] = array( array( 'elType' => 'container', 'elements' => array() ) ); $node = &$node['elements'][0]; }
ok( is_wp_error( StyleLift_Sanitizer::clean_elements( array( $deep ) ) ), 'absurd nesting rejected' );

$urls = StyleLift_Importer::find_image_urls( $clean );
sort( $urls );
ok( $urls === array( 'https://cdn.example.com/a.jpg?w=800&q=80', 'https://cdn.example.com/a@2x.jpg', 'https://cdn.example.com/bg.webp' ), 'image URLs found in src, srcset and CSS url() (' . implode( ', ', $urls ) . ')' );
$moved = StyleLift_Importer::replace_urls( $clean, array( 'https://cdn.example.com/a.jpg?w=800&q=80' => 'https://my.site/wp-content/uploads/a.jpg', 'https://cdn.example.com/bg.webp' => 'https://my.site/wp-content/uploads/bg.webp', 'https://cdn.example.com/a@2x.jpg' => false ) );
$mh = $moved[0]['elements'][0]['settings']['html'];
ok( false !== strpos( $mh, 'src="https://my.site/wp-content/uploads/a.jpg"' ), 'HTML-encoded image URL rewritten to the Media Library copy' );
ok( false !== strpos( $mh, "url('https://my.site/wp-content/uploads/bg.webp')" ), 'CSS background rewritten' );
ok( false !== strpos( $mh, 'https://cdn.example.com/a@2x.jpg 2x' ), 'a failed download keeps its original URL' );

echo "\n$passed passed, " . count( $failed ) . " failed\n";
if ( $failed ) { exit( 1 ); }
echo "WordPress importer logic verified ✓\n";
